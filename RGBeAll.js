// NOTE: @SignalRGB/tcp is NOT available in the device context - see RGBeAllBridge.js
import udp from "@SignalRGB/udp";

/**
 * RGBeAll - a SignalRGB plugin for Magic Home / Zengge "LEDNET" Wi-Fi RGB controllers.
 *
 * Targets the ANALOG (non-addressable) controller family - device type 0x33 and relatives -
 * which drive a common-anode 12V/24V RGB strip from a 4-pin "+ R G B" header. The whole strip
 * is a single colour zone; see README for what that means for effects.
 *
 * Transport is the legacy plaintext LEDNET protocol on TCP 5577. Discovery is a UDP broadcast
 * on 48899. Neither is encrypted or authenticated - see docs/SECURITY.md.
 */

export function Name() { return "RGBeAll"; }
export function Version() { return "1.1.0"; }
export function Type() { return "network"; }
export function Publisher() { return "RGBeAll"; }
export function Size() { return [5, 1]; }
export function DefaultPosition() { return [0, 70]; }
export function DefaultScale() { return 8.0; }
export function ProductLink() { return "https://github.com/emoraru/RGBeAll"; }

/* global
controller:readonly
discovery:readonly
LightingMode:readonly
forcedColor:readonly
samplingMode:readonly
maxBrightness:readonly
gammaCorrection:readonly
frameRateCap:readonly
onShutdown:readonly
restoreColor:readonly
watchdogSeconds:readonly
*/

export function ControllableParameters() {
	return [
		{
			property: "LightingMode", group: "lighting", label: "Lighting Mode",
			description: "Canvas pulls colour from the active SignalRGB effect. Forced overrides it with a fixed colour.",
			type: "combobox", values: ["Canvas", "Forced"], default: "Canvas",
		},
		{
			property: "forcedColor", group: "lighting", label: "Forced Colour",
			min: "0", max: "360", type: "color", default: "#009bde",
		},
		{
			property: "samplingMode", group: "lighting", label: "Canvas Sampling",
			description: "This controller has one colour zone. Centre samples the middle of the device box (keeps colours saturated). Average blends all five sample points (smoother, but desaturates gradients toward grey).",
			type: "combobox", values: ["Centre", "Average"], default: "Centre",
		},
		{
			property: "maxBrightness", group: "lighting", label: "Max Brightness (%)",
			description: "Scales every channel. Useful because analog strips are often much brighter than case lighting.",
			step: "1", type: "number", min: "1", max: "100", default: "100",
		},
		{
			property: "gammaCorrection", group: "lighting", label: "Gamma Correction",
			description: "Applies a perceptual curve so dim colours look right on a PWM-driven analog strip.",
			type: "boolean", default: "true",
		},
		{
			property: "frameRateCap", group: "settings", label: "Frame Rate Cap (FPS)",
			description: "Updates per second sent to the controller. 30 is comfortable on ESP8266-based units; lower it if the strip stutters.",
			step: "1", type: "number", min: "1", max: "40", default: "30",
		},
		{
			property: "onShutdown", group: "settings", label: "When SignalRGB stops",
			description: "What the strip should do when SignalRGB exits, the PC shuts down, or control is otherwise lost. Restoring a colour first means the strip shows that colour - not a random effect frame - the next time you switch it on from the phone app.",
			type: "combobox",
			values: ["Restore colour and turn off", "Restore colour, leave on", "Leave as-is"],
			default: "Restore colour and turn off",
		},
		{
			property: "restoreColor", group: "settings", label: "Restore Colour",
			description: "The colour the strip is left showing when SignalRGB stops.",
			min: "0", max: "360", type: "color", default: "#FF3808",
		},
		{
			property: "watchdogSeconds", group: "settings", label: "Takeover Timeout (s)",
			description: "If SignalRGB stops sending frames for this long while still running - the device is disabled, or lighting is turned off - the strip falls back to the setting above. Set to 0 to disable.",
			step: "1", type: "number", min: "0", max: "120", default: "8",
		},
	];
}

// ---------------------------------------------------------------------------
// Device layout
//
// The controller is a single colour zone, but we expose five sample points so the
// device box can be positioned across the canvas and sampled meaningfully. Render()
// collapses them to one RGB triple according to samplingMode.
// ---------------------------------------------------------------------------

const SAMPLE_POINTS = 5;
const CENTRE_INDEX = 2;

const vLedNames = ["Sample 1", "Sample 2", "Sample 3", "Sample 4", "Sample 5"];
const vLedPositions = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];

export function LedNames() { return vLedNames; }
export function LedPositions() { return vLedPositions; }

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const LEDNET = {
	PORT: 5577,
	DISCOVERY_PORT: 48899,
	DISCOVERY_MAGIC: "HF-A11ASSISTHREAD",

	/** Append the LEDNET checksum: sum of all preceding bytes, low byte only. */
	frame(bytes) {
		let sum = 0;
		for (let i = 0; i < bytes.length; i++) { sum += bytes[i]; }
		return bytes.concat([sum & 0xFF]);
	},

	/**
	 * Set colour.
	 *
	 * Byte 5 (0xF0) writes the colour channels only, leaving the white channel alone.
	 * Trailing 0x0F requests an acknowledgement.
	 *
	 * Head byte 0x31 persists; 0x41 is documented elsewhere as non-persistent but is NOT
	 * honoured as such by every firmware revision. It does not matter much in practice:
	 * these controllers defer the save rather than writing flash per frame, which is what
	 * makes 30 FPS streaming safe. See docs/PROTOCOL.md.
	 */
	setColour(r, g, b) {
		return this.frame([0x31, r & 0xFF, g & 0xFF, b & 0xFF, 0x00, 0xF0, 0x0F]);
	},

	powerOn() { return this.frame([0x71, 0x23, 0x0F]); },
	powerOff() { return this.frame([0x71, 0x24, 0x0F]); },
	queryState() { return this.frame([0x81, 0x8A, 0x8B]); },
};

/** Perceptual curve for PWM-driven analog channels. */
const GAMMA_TABLE = (() => {
	const t = new Array(256);
	for (let i = 0; i < 256; i++) {
		t[i] = Math.round(Math.pow(i / 255, 2.2) * 255);
	}
	return t;
})();

function clampByte(v) {
	if (!isFinite(v)) { return 0; }
	if (v < 0) { return 0; }
	if (v > 255) { return 255; }
	return Math.round(v);
}

function hexToRgb(hex) {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
	if (!m) { return [0, 0, 0]; }
	return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// ---------------------------------------------------------------------------
// Transport
//
// SignalRGB does not expose @SignalRGB/tcp to the device (render) context - the
// import fails there with "Could not open module" - and Magic Home controllers
// accept colour only over TCP 5577. So frames go out over loopback UDP to
// RGBeAllBridge.js, which runs in the discovery context where TCP does work,
// and forwards them to the controller.
//
// Both files ship together and both live in the Plugins folder. There is no
// external process and nothing to start at boot.
// ---------------------------------------------------------------------------

const RELAY_HOST = "127.0.0.1";
const RELAY_PORT = 41577;
const RELAY_MAGIC = 0x52;        // forward a LEDNET frame
const RELAY_CONFIG = 0x53;       // tell the bridge what to do when frames stop

// Re-send the current colour at least this often even when it has not changed.
// Two reasons: it keeps the bridge's watchdog fed so silence genuinely means "control
// lost", and it re-asserts control if something else (the phone app, a remote) changed
// the strip while SignalRGB was running.
const HEARTBEAT_MS = 1000;
const CONFIG_INTERVAL_MS = 5000;

// The bridge consumes the first frame to open its TCP connection, so power-on is
// repeated for the first few frames rather than sent once.
const PRIME_FRAMES = 3;

const HEX_DIGITS = "0123456789ABCDEF";

/** Encode a byte array as ASCII hex characters, returned as bytes for udp.write(). */
function toHexBytes(bytes) {
	const out = [];
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i] & 0xFF;
		out.push(HEX_DIGITS.charCodeAt(b >> 4));
		out.push(HEX_DIGITS.charCodeAt(b & 0x0F));
	}
	return out;
}

function parseOctets(ip) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ""));
	if (!m) { return null; }

	const out = [];
	for (let i = 1; i <= 4; i++) {
		const v = parseInt(m[i], 10);
		if (v < 0 || v > 255) { return null; }
		out.push(v);
	}
	return out;
}

class MagicHomeLink {
	constructor(ip) {
		this.ip = ip;
		this.octets = parseOctets(ip);
		this.socket = null;
		this.connected = false;
		this.lastSentAt = 0;
		this.lastHeartbeatAt = 0;
		this.lastConfigAt = 0;
		this.lastColour = null;
		this.primeSent = 0;
	}

	get primed() { return this.primeSent >= PRIME_FRAMES; }

	connect() {
		if (this.socket) { return; }
		if (!this.octets) {
			device.log("Invalid controller address: " + this.ip);
			return;
		}

		try {
			this.socket = udp.createSocket();
			this.connected = true;
			device.log("Relaying to " + this.ip + " through the bridge on port " + RELAY_PORT);
		} catch (e) {
			this.connected = false;
			device.log("Could not open relay socket: " + e);
		}
	}

	/**
	 * Wrap a LEDNET frame in the relay header and hand it to the bridge.
	 *
	 * Encoded as ASCII hex, two characters per byte. The receiving side reads the
	 * datagram as a UTF-8 string, which mangles every byte above 0x7F - a raw binary
	 * payload arrives corrupted. Hex keeps everything inside 7-bit ASCII.
	 */
	send(frame) {
		if (!this.socket || !this.octets) { return false; }

		const packet = [RELAY_MAGIC].concat(this.octets, frame);

		try {
			this.socket.write(toHexBytes(packet), RELAY_HOST, RELAY_PORT);
			return true;
		} catch (e) {
			device.log("Relay send failed: " + e);
			this.connected = false;
			this.socket = null;
			return false;
		}
	}

	/**
	 * Power the strip on.
	 *
	 * Power-on makes the controller reload its last saved colour from non-volatile
	 * storage, so the first rendered colour follows immediately on the next frame
	 * (~33ms later) to keep the stale-colour flash imperceptible. Spacing the two
	 * also avoids back-to-back writes on the bridge's TCP socket, which the
	 * controller does not reliably accept.
	 */
	prime() {
		this.send(LEDNET.powerOn());
		this.primeSent++;
	}

	/** Rate-limited, de-duplicated colour write, with a periodic heartbeat. */
	pushColour(rgb, minIntervalMs) {
		const now = Date.now();
		if (now - this.lastSentAt < minIntervalMs) { return; }

		const prev = this.lastColour;
		const unchanged = prev && prev[0] === rgb[0] && prev[1] === rgb[1] && prev[2] === rgb[2];

		if (unchanged && now - this.lastHeartbeatAt < HEARTBEAT_MS) {
			this.lastSentAt = now;
			return;
		}

		if (this.send(LEDNET.setColour(rgb[0], rgb[1], rgb[2]))) {
			this.lastColour = rgb.slice();
			this.lastSentAt = now;
			this.lastHeartbeatAt = now;
		}
	}

	/** Tell the bridge what to leave the strip in if our frames stop arriving. */
	sendConfig(mode, rgb, watchdogSecs) {
		if (!this.socket || !this.octets) { return; }

		const packet = [RELAY_CONFIG].concat(this.octets, [
			mode & 0xFF, rgb[0] & 0xFF, rgb[1] & 0xFF, rgb[2] & 0xFF, watchdogSecs & 0xFF,
		]);

		try {
			this.socket.write(toHexBytes(packet), RELAY_HOST, RELAY_PORT);
			this.lastConfigAt = Date.now();
		} catch (e) {
			device.log("Relay config send failed: " + e);
		}
	}

	closeSocket() {
		try { if (this.socket) { this.socket.close(); } } catch (e) { /* already gone */ }
		this.socket = null;
		this.connected = false;
	}
}

// Shutdown modes, shared with the bridge over the config channel.
const SHUTDOWN_LEAVE = 0;
const SHUTDOWN_RESTORE = 1;
const SHUTDOWN_RESTORE_AND_OFF = 2;

function shutdownMode() {
	if (onShutdown === "Leave as-is") { return SHUTDOWN_LEAVE; }
	if (onShutdown === "Restore colour, leave on") { return SHUTDOWN_RESTORE; }
	return SHUTDOWN_RESTORE_AND_OFF;
}

function restoreRgb() {
	const c = hexToRgb(restoreColor);
	return [clampByte(c[0]), clampByte(c[1]), clampByte(c[2])];
}

function clampWatchdog(v) {
	const n = parseInt(v, 10);
	if (!isFinite(n) || n < 0) { return 8; }
	if (n > 120) { return 120; }
	return n;
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

let link = null;

export function Initialize() {
	device.setName(controller.name || "RGBeAll Controller");
	device.addFeature("base");

	link = new MagicHomeLink(controller.ip);
	link.connect();

	applyFrameRateCap();
}

function applyFrameRateCap() {
	const fps = clampFps(frameRateCap);
	try {
		if (typeof device.setFrameRateTarget === "function") {
			device.setFrameRateTarget(fps);
		}
	} catch (e) {
		device.log(`Could not set frame rate target: ${e}`);
	}
}

function clampFps(v) {
	const n = parseInt(v, 10);
	if (!isFinite(n) || n < 1) { return 30; }
	if (n > 40) { return 40; }
	return n;
}

export function Render() {
	if (!link) { return; }

	if (!link.connected) {
		link.connect();
		return;
	}

	const rgb = resolveColour();
	const minInterval = 1000 / clampFps(frameRateCap);

	if (!link.primed) {
		link.prime();
		return;
	}

	link.pushColour(rgb, minInterval);

	// Keep the bridge's copy of the shutdown behaviour current. Cheap, and it means a
	// settings change takes effect without a restart.
	if (Date.now() - link.lastConfigAt > CONFIG_INTERVAL_MS) {
		link.sendConfig(shutdownMode(), restoreRgb(), clampWatchdog(watchdogSeconds));
	}
}

/**
 * Leave the strip in a known state.
 *
 * The controller keeps the last colour in non-volatile storage and reloads it on
 * power-on, so restoring a colour here decides what the strip shows the next time it
 * is switched on from the phone app - rather than whatever effect frame happened to
 * land last. Testing confirmed the colour persists even when the power-off command
 * follows immediately, so no delay is needed between the two.
 *
 * The bridge repeats this independently from its own Shutdown and watchdog, because
 * during application exit there is no guarantee this runs before the socket goes away.
 */
export function Shutdown(SystemSuspending) {
	if (!link) { return; }

	const mode = shutdownMode();

	if (mode !== SHUTDOWN_LEAVE) {
		const rgb = restoreRgb();
		link.send(LEDNET.setColour(rgb[0], rgb[1], rgb[2]));
		if (mode === SHUTDOWN_RESTORE_AND_OFF) { link.send(LEDNET.powerOff()); }
	}

	link.closeSocket();
	link.connected = false;
	link = null;
}

/** Collapse the sampled canvas points to one gamma- and brightness-corrected RGB triple. */
function resolveColour() {
	let r, g, b;

	if (LightingMode === "Forced") {
		const c = hexToRgb(forcedColor);
		r = c[0]; g = c[1]; b = c[2];
	} else if (samplingMode === "Average") {
		let sr = 0, sg = 0, sb = 0;
		for (let i = 0; i < SAMPLE_POINTS; i++) {
			const c = device.color(vLedPositions[i][0], vLedPositions[i][1]);
			sr += c[0]; sg += c[1]; sb += c[2];
		}
		r = sr / SAMPLE_POINTS; g = sg / SAMPLE_POINTS; b = sb / SAMPLE_POINTS;
	} else {
		const c = device.color(vLedPositions[CENTRE_INDEX][0], vLedPositions[CENTRE_INDEX][1]);
		r = c[0]; g = c[1]; b = c[2];
	}

	if (gammaCorrection) {
		r = GAMMA_TABLE[clampByte(r)];
		g = GAMMA_TABLE[clampByte(g)];
		b = GAMMA_TABLE[clampByte(b)];
	}

	const scale = Math.max(1, Math.min(100, parseInt(maxBrightness, 10) || 100)) / 100;

	return [clampByte(r * scale), clampByte(g * scale), clampByte(b * scale)];
}

// ---------------------------------------------------------------------------
// Discovery
//
// Magic Home controllers answer a UDP broadcast of the ASCII string "HF-A11ASSISTHREAD"
// on port 48899 with "<ip>,<mac>,<model>". Manual entry by IP is always available and is
// the recommended path if discovery is blocked by client isolation or a firewall.
// ---------------------------------------------------------------------------

const DISCOVERY_INTERVAL_MS = 30000;
const OFFLINE_AFTER_MS = 180000;

export function DiscoveryService() {
	this.UdpBroadcastPort = LEDNET.DISCOVERY_PORT;
	this.UdpListenPort = LEDNET.DISCOVERY_PORT;
	this.UdpBroadcastAddress = "255.255.255.255";

	this.lastPollTime = 0;

	this.Initialize = function () {
		service.log("RGBeAll: searching for Magic Home controllers...");
		this.loadManualDevices();
	};

	this.CheckForDevices = function () {
		if (Date.now() - this.lastPollTime < DISCOVERY_INTERVAL_MS) { return; }
		this.lastPollTime = Date.now();
		service.broadcast(LEDNET.DISCOVERY_MAGIC);
	};

	this.Update = function () {
		for (const cont of service.controllers) {
			cont.obj.update();
		}
		this.CheckForDevices();
	};

	/**
	 * Handle a discovery reply.
	 *
	 * Replies are untrusted network input from an unauthenticated protocol: anything on the
	 * LAN can send one. Parse strictly and reject anything that does not match the exact
	 * "<ipv4>,<12 hex mac>,<model>" shape.
	 */
	this.Discovered = function (value) {
		const parsed = parseDiscoveryReply(value && value.response);
		if (!parsed) { return; }

		const existing = service.getController(parsed.mac);
		if (existing === undefined) {
			service.log(`RGBeAll: discovered controller ${parsed.model}`);
			service.addController(new MagicHomeController(parsed));
		} else {
			existing.updateFromDiscovery(parsed);
		}
	};

	/** Manually add a controller by IP, for networks where broadcast discovery does not work. */
	this.forceDiscover = function (ipAddress) {
		if (!isValidIPv4(ipAddress)) {
			service.log(`Ignoring invalid IP address: ${ipAddress}`);
			return;
		}

		const id = `manual-${ipAddress}`;
		if (service.getController(id) !== undefined) {
			service.log(`Controller for ${ipAddress} already exists`);
			return;
		}

		service.log(`RGBeAll: manually adding controller at ${ipAddress}`);
		this.saveManualDevice(ipAddress);
		service.addController(new MagicHomeController({
			ip: ipAddress, mac: id, model: "Magic Home (manual)", manual: true,
		}));
	};

	this.forceDelete = function (ipAddress) {
		for (const cont of service.controllers) {
			if (cont.obj.ip === ipAddress) {
				service.removeSetting(cont.obj.id, "ip");
				service.removeController(cont);
				this.removeManualDevice(ipAddress);
				service.log(`Removed controller at ${ipAddress}`);
				return;
			}
		}
	};

	this.saveManualDevice = function (ip) {
		const list = this.readManualList();
		if (list.indexOf(ip) === -1) {
			list.push(ip);
			service.saveSetting("manual", "devices", JSON.stringify(list));
		}
	};

	this.removeManualDevice = function (ip) {
		const list = this.readManualList().filter((x) => x !== ip);
		service.saveSetting("manual", "devices", JSON.stringify(list));
	};

	this.readManualList = function () {
		const raw = service.getSetting("manual", "devices");
		if (raw === undefined || raw.length === 0) { return []; }
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter(isValidIPv4) : [];
		} catch (e) {
			return [];
		}
	};

	this.loadManualDevices = function () {
		for (const ip of this.readManualList()) {
			if (service.getController(`manual-${ip}`) === undefined) {
				service.addController(new MagicHomeController({
					ip: ip, mac: `manual-${ip}`, model: "Magic Home (manual)", manual: true,
				}));
			}
		}
	};
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAC_RE = /^[0-9A-Fa-f]{12}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,32}$/;

function isValidIPv4(ip) {
	const m = IPV4_RE.exec(String(ip || "").trim());
	if (!m) { return false; }
	for (let i = 1; i <= 4; i++) {
		const octet = parseInt(m[i], 10);
		if (octet < 0 || octet > 255) { return false; }
	}
	return true;
}

function parseDiscoveryReply(response) {
	if (typeof response !== "string") { return null; }

	const text = response.trim();
	// Guard against oversized or malformed payloads before doing any work on them.
	if (text.length === 0 || text.length > 128) { return null; }

	const parts = text.split(",");
	if (parts.length !== 3) { return null; }

	const ip = parts[0].trim();
	const mac = parts[1].trim();
	const model = parts[2].trim();

	if (!isValidIPv4(ip)) { return null; }
	if (!MAC_RE.test(mac)) { return null; }
	if (!MODEL_RE.test(model)) { return null; }

	return { ip: ip, mac: mac.toUpperCase(), model: model, manual: false };
}

class MagicHomeController {
	constructor(info) {
		this.ip = info.ip;
		this.port = LEDNET.PORT;
		this.mac = info.mac;
		this.id = info.mac;
		this.model = info.model;
		this.manual = !!info.manual;
		this.name = this.manual ? `Magic Home ${this.ip}` : `Magic Home ${this.model}`;

		this.lastSeen = Date.now();
		this.offline = false;
		this.initialized = false;

		service.log(`Controller registered: ${this.name}`);
	}

	updateFromDiscovery(info) {
		this.lastSeen = Date.now();
		if (info.ip !== this.ip) {
			service.log(`Controller ${this.id} moved to a new address`);
			this.ip = info.ip;
			this.initialized = false;
		}
		if (this.offline) {
			this.offline = false;
			service.updateController(this);
		}
	}

	update() {
		if (!this.initialized) {
			this.initialized = true;
			service.updateController(this);
			service.announceController(this);
			return;
		}

		// Manually added controllers never receive discovery replies, so they are never
		// aged out - only broadcast-discovered ones are.
		if (!this.manual && Date.now() - this.lastSeen > OFFLINE_AFTER_MS && !this.offline) {
			this.offline = true;
			service.log(`Controller ${this.id} has not answered discovery recently`);
			service.updateController(this);
		}
	}

	// --- actions invoked from RGBeAll.qml -------------------------------

	/** Stop driving this controller, but keep it in the list so it can be re-linked. */
	startRemove() {
		this.initialized = false;
		service.suppressController(this);
		service.updateController(this);
	}

	/** Forget this controller entirely, including any saved manual entry. */
	startDelete() {
		discovery.forceDelete(this.ip);
	}
}
