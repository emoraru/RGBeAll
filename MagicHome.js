import tcp from "@SignalRGB/tcp";
import udp from "@SignalRGB/udp";

/**
 * Magic Home / Zengge "LEDNET" Wi-Fi RGB controller plugin for SignalRGB.
 *
 * Targets the ANALOG (non-addressable) controller family - device type 0x33 and relatives -
 * which drive a common-anode 12V/24V RGB strip from a 4-pin "+ R G B" header. The whole strip
 * is a single colour zone; see README for what that means for effects.
 *
 * Transport is the legacy plaintext LEDNET protocol on TCP 5577. Discovery is a UDP broadcast
 * on 48899. Neither is encrypted or authenticated - see docs/SECURITY.md.
 */

export function Name() { return "Magic Home RGB Controller"; }
export function Version() { return "1.0.0"; }
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
turnOffOnShutdown:readonly
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
			property: "turnOffOnShutdown", group: "settings", label: "Turn strip off on shutdown",
			type: "boolean", default: "false",
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
// Connection
// ---------------------------------------------------------------------------

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class MagicHomeLink {
	constructor(ip, port) {
		this.ip = ip;
		this.port = port || LEDNET.PORT;
		this.socket = null;
		this.connected = false;
		this.connecting = false;
		this.failures = 0;
		this.nextAttemptAt = 0;
		this.lastSentAt = 0;
		this.lastColour = null;
		this.primed = false;
	}

	connect() {
		if (this.connected || this.connecting) { return; }
		if (Date.now() < this.nextAttemptAt) { return; }

		this.connecting = true;
		try {
			this.socket = tcp.createSocket();

			// The controller acknowledges every command (1 byte for set-colour, 4 for power).
			// We never do synchronous reads here, so acks are simply consumed and discarded -
			// that sidesteps the frame-desync trap described in docs/PROTOCOL.md.
			const onUp = () => { this.onConnected(); };
			const onDown = () => { this.onDisconnected(); };

			// Event naming differs slightly between SignalRGB builds; register the known
			// variants and treat any of them as the same signal.
			this.safeOn("connection", onUp);
			this.safeOn("connected", onUp);
			this.safeOn("close", onDown);
			this.safeOn("disconnected", onDown);
			this.safeOn("error", (e) => { this.onError(e); });
			this.safeOn("message", () => { /* ack - intentionally discarded */ });

			this.socket.connect(this.ip, this.port);
		} catch (e) {
			this.connecting = false;
			this.onError(e);
		}
	}

	safeOn(event, handler) {
		try {
			if (this.socket && typeof this.socket.on === "function") {
				this.socket.on(event, handler);
			}
		} catch (e) {
			// Unsupported event name on this build - ignore, the logic does not depend on it.
		}
	}

	onConnected() {
		this.connecting = false;
		this.connected = true;
		this.failures = 0;
		this.primed = false;
		device.log(`Connected to Magic Home controller at ${this.ip}:${this.port}`);
	}

	onDisconnected() {
		if (this.connected) { device.log(`Connection to ${this.ip} closed`); }
		this.connected = false;
		this.connecting = false;
		this.scheduleRetry();
	}

	onError(e) {
		this.connected = false;
		this.connecting = false;
		device.log(`Socket error for ${this.ip}: ${e}`);
		this.scheduleRetry();
	}

	scheduleRetry() {
		this.failures++;
		const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.failures - 1), RECONNECT_MAX_MS);
		this.nextAttemptAt = Date.now() + backoff;
		this.closeSocket();
	}

	closeSocket() {
		try { if (this.socket) { this.socket.close(); } } catch (e) { /* already gone */ }
		this.socket = null;
	}

	send(bytes) {
		if (!this.connected || !this.socket) { return false; }
		try {
			this.socket.send(bytes);
			return true;
		} catch (e) {
			this.onError(e);
			return false;
		}
	}

	/**
	 * Power the strip on and immediately write a colour.
	 *
	 * Power-on makes the controller reload its last saved colour from non-volatile storage,
	 * so without an immediate write the strip visibly flashes a stale colour.
	 */
	prime(rgb) {
		if (this.primed) { return; }
		this.send(LEDNET.powerOn());
		this.send(LEDNET.setColour(rgb[0], rgb[1], rgb[2]));
		this.lastColour = rgb.slice();
		this.lastSentAt = Date.now();
		this.primed = true;
	}

	/** Rate-limited, de-duplicated colour write. */
	pushColour(rgb, minIntervalMs) {
		const now = Date.now();
		if (now - this.lastSentAt < minIntervalMs) { return; }

		const prev = this.lastColour;
		if (prev && prev[0] === rgb[0] && prev[1] === rgb[1] && prev[2] === rgb[2]) {
			this.lastSentAt = now;
			return;
		}

		if (this.send(LEDNET.setColour(rgb[0], rgb[1], rgb[2]))) {
			this.lastColour = rgb.slice();
			this.lastSentAt = now;
		}
	}
}

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

let link = null;

export function Initialize() {
	device.setName(controller.name || "Magic Home RGB Controller");
	device.addFeature("base");

	link = new MagicHomeLink(controller.ip, controller.port);
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
		link.prime(rgb);
		return;
	}

	link.pushColour(rgb, minInterval);
}

export function Shutdown(SystemSuspending) {
	if (!link) { return; }

	if (SystemSuspending || turnOffOnShutdown) {
		link.send(LEDNET.setColour(0, 0, 0));
		if (turnOffOnShutdown) { link.send(LEDNET.powerOff()); }
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
		service.log("Searching for Magic Home controllers...");
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
			service.log(`Discovered Magic Home controller: ${parsed.model}`);
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

		service.log(`Manually adding Magic Home controller at ${ipAddress}`);
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

	// --- actions invoked from MagicHome.qml -------------------------------

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
