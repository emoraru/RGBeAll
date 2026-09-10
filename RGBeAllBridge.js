import tcp from "@SignalRGB/tcp";
import udp from "@SignalRGB/udp";

/**
 * RGBeAll - TCP bridge half of the plugin.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * SignalRGB runs plugin code in two separate JavaScript contexts, and they do not
 * expose the same modules:
 *
 *   - the DISCOVERY (service) context, where `@SignalRGB/tcp` resolves
 *   - the DEVICE (render) context, where it does NOT - the import fails with
 *     "Could not open module .../@SignalRGB/tcp for reading", once per frame,
 *     while `@SignalRGB/udp` works in both
 *
 * Magic Home controllers accept colour only over TCP 5577; their Wi-Fi module has no
 * UDP control path. So the rendering half of the plugin cannot reach them directly,
 * and the engine is pre-ES2020, so a dynamic `import()` fallback is a syntax error.
 *
 * This file is the other half. It runs in the discovery context, holds the TCP
 * connections, and forwards frames that RGBeAll.js sends over loopback UDP.
 * Everything stays inside SignalRGB: no external daemon, no background service,
 * nothing to start at boot. Both files just live in the Plugins folder.
 *
 * If a future SignalRGB build exposes `@SignalRGB/tcp` to the device context, this
 * file becomes unnecessary and RGBeAll.js can open the socket itself.
 */

export function Name() { return "RGBeAll Bridge"; }
export function Version() { return "1.3.0"; }
export function Type() { return "network"; }
export function Publisher() { return "RGBeAll"; }
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [0, 0]; }
export function DefaultScale() { return 1.0; }
export function LedNames() { return ["Bridge"]; }
export function LedPositions() { return [[0, 0]]; }
export function ControllableParameters() { return []; }

// This plugin never announces a device; it exists only for its DiscoveryService.
export function Initialize() {}
export function Render() {}
export function Shutdown() {}

// ---------------------------------------------------------------------------
// Relay protocol (loopback only)
//
// Datagrams are ASCII HEX, two characters per byte. That is not decoration: the
// udp `message` callback hands back `msg.data` as a UTF-8 decoded string, and every
// byte above 0x7F is mangled to 0x7D in transit. A raw binary payload therefore
// arrives corrupted - a destination address loses any octet above 127. Hex keeps the
// whole payload inside 7-bit ASCII, which survives intact.
//
// Decoded layout:
//   byte 0      0x52 forward a LEDNET frame, 0x53 configure shutdown behaviour
//   bytes 1-4   destination IPv4, one octet per byte
//   bytes 5+    the LEDNET frame, or [mode, r, g, b, watchdogSeconds]
// ---------------------------------------------------------------------------

const RELAY_PORT = 41577;
const RELAY_MAGIC = 0x52;        // forward a LEDNET frame
const RELAY_CONFIG = 0x53;       // shutdown behaviour for a controller
const RELAY_HEADER = 5;
const LEDNET_PORT = 5577;

// Shutdown modes, mirrored from RGBeAll.js.
const SHUTDOWN_LEAVE = 0;
const SHUTDOWN_RESTORE = 1;
const SHUTDOWN_RESTORE_AND_OFF = 2;
const SHUTDOWN_OFF_ONLY = 3;

/** Build a LEDNET frame: payload plus the low byte of its sum. */
function lednetFrame(bytes) {
	let sum = 0;
	for (let i = 0; i < bytes.length; i++) { sum += bytes[i]; }
	return bytes.concat([sum & 0xFF]);
}

// Only these LEDNET commands are ever forwarded.
const ALLOWED_COMMANDS = [0x31, 0x41, 0x71, 0x81];

const CMD_COLOUR_A = 0x31;
const CMD_COLOUR_B = 0x41;
const CMD_POWER = 0x71;

// Qt's QAbstractSocket::ConnectedState
const STATE_CONNECTED = 3;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const IDLE_CLOSE_MS = 120000;

// Keeps the power channel from going stale. Measured usable after 90s idle, but a PC
// runs far longer than that between shutdowns, and a state query costs nothing.
const KEEPALIVE_MS = 30000;

// ---------------------------------------------------------------------------
// Why there are two sockets per controller
//
// Restoring a colour and switching the strip off needs two DIFFERENT commands, and
// four properties of this hardware conspire against sending them:
//
//   1. Colour and power are separate persisted state - colour survives a power cycle.
//   2. Colour writes are DISCARDED while the strip is off, so the colour has to be
//      written while it is still on. The order is forced: colour, then power off.
//   3. The controller acts on only the FIRST command in a TCP packet.
//   4. Qt flushes writes once per turn of its event loop, so two sends in one turn
//      share a packet - and at shutdown there is no next turn to use.
//
// Repeating the power-off does not help: if it shares a packet with the colour, the
// controller takes the colour and ignores the rest.
//
// Two sockets cannot share a packet, which removes 3 and 4 entirely. Commands are
// routed by type - colour on one, power on the other - so any colour/power pair ends
// up in separate packets no matter how the event loop schedules them. Verified on the
// hardware: written in the same tick on two sockets, both land.
// ---------------------------------------------------------------------------

/** One TCP connection to a controller, with reconnect backoff. */
class Channel {
	constructor(ip, label) {
		this.ip = ip;
		this.label = label;
		this.socket = null;
		this.ready = false;
		this.connecting = false;
		this.failures = 0;
		this.nextAttemptAt = 0;
		this.lastSendAt = 0;
	}

	on(event, handler) {
		try {
			if (this.socket && typeof this.socket.on === "function") {
				this.socket.on(event, handler);
			}
		} catch (e) {
			// Unsupported event name on this build; the logic does not depend on it.
		}
	}

	/** Trust the socket's own state as well as the event, in case the event is missed. */
	isReady() {
		if (this.ready) { return true; }
		try {
			if (this.socket && this.socket.state === STATE_CONNECTED) {
				this.ready = true;
				return true;
			}
		} catch (e) { /* fall through */ }
		return false;
	}

	ensureConnected(onUp) {
		if (this.isReady() || this.connecting) { return; }
		if (Date.now() < this.nextAttemptAt) { return; }

		this.connecting = true;
		const self = this;

		try {
			this.socket = tcp.createSocket();

			const up = function () {
				self.connecting = false;
				self.ready = true;
				self.failures = 0;
				service.log("RGBeAll Bridge: " + self.label + " channel connected to " + self.ip);
				if (onUp) { onUp(); }
			};
			const down = function () {
				self.ready = false;
				self.connecting = false;
				self.scheduleRetry();
			};

			// Event names vary slightly between builds; treat any of them as the same signal.
			this.on("connection", up);
			this.on("connected", up);
			this.on("close", down);
			this.on("disconnected", down);
			this.on("error", function (e) {
				service.log("RGBeAll Bridge: " + self.label + " channel error for " + self.ip + ": " + e);
				self.ready = false;
				self.connecting = false;
				self.scheduleRetry();
			});
			// Acks are consumed and discarded. Nothing here ever does a synchronous read,
			// so the frame-desync trap in docs/PROTOCOL.md cannot occur.
			this.on("message", function () { });

			this.socket.connect(this.ip, LEDNET_PORT);
		} catch (e) {
			this.connecting = false;
			service.log("RGBeAll Bridge: " + this.label + " channel failed to connect to " + this.ip + ": " + e);
			this.scheduleRetry();
		}
	}

	scheduleRetry() {
		this.failures++;
		const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.failures - 1), RECONNECT_MAX_MS);
		this.nextAttemptAt = Date.now() + backoff;
		this.close();
	}

	close() {
		try { if (this.socket) { this.socket.close(); } } catch (e) { /* already gone */ }
		this.socket = null;
		this.ready = false;
	}

	send(frame) {
		if (!this.isReady()) { return false; }

		try {
			this.socket.send(frame);
			this.lastSendAt = Date.now();
			return true;
		} catch (e) {
			service.log("RGBeAll Bridge: " + this.label + " channel send failed for " + this.ip + ": " + e);
			this.ready = false;
			this.scheduleRetry();
			return false;
		}
	}
}

/** A controller, reached over one channel for colour and another for power. */
class BridgeConnection {
	constructor(ip) {
		this.ip = ip;
		this.colour = new Channel(ip, "colour");
		this.power = new Channel(ip, "power");
		this.lastUsedAt = Date.now();

		// A newly connected controller may be switched off - typically because the last
		// shutdown turned it off. Colour commands are ignored while it is off, so the
		// first thing sent on any new connection has to be a power-on.
		this.needsPowerOn = true;

		// Set from the config channel; null until RGBeAll.js has told us what to do.
		this.fallback = null;
		this.lastFrameAt = 0;
		this.fallbackApplied = false;
	}

	ensureConnected() {
		const self = this;
		// Re-armed on every reconnect, not just the first, so a dropped link also
		// recovers a strip that was switched off in the meantime.
		this.colour.ensureConnected(function () { self.needsPowerOn = true; });
		this.power.ensureConnected(null);
	}

	/** Route by command type, so colour and power can never share a packet. */
	send(frame) {
		this.lastUsedAt = Date.now();

		const cmd = frame[0];

		if (cmd === CMD_POWER) {
			// Fall back to the colour channel if the power channel is not up yet: one
			// command still beats none, it just loses the packet-separation guarantee.
			if (this.power.send(frame)) { return true; }
			return this.colour.send(frame);
		}

		if (cmd === CMD_COLOUR_A || cmd === CMD_COLOUR_B) {
			return this.colour.send(frame);
		}

		// Anything else (a state query) goes on whichever channel is up.
		if (this.colour.send(frame)) { return true; }
		return this.power.send(frame);
	}

	isReady() { return this.colour.isReady() || this.power.isReady(); }

	close() {
		this.colour.close();
		this.power.close();
	}

	/**
	 * Keep the power channel from going stale.
	 *
	 * It carries no traffic between shutdowns, yet it is the one that has to work at
	 * the exact moment the machine is going down. The state query is read-only.
	 */
	keepAlive() {
		if (!this.power.isReady()) { return; }
		if (Date.now() - this.power.lastSendAt < KEEPALIVE_MS) { return; }
		this.power.send(lednetFrame([0x81, 0x8A, 0x8B]));
	}

	/**
	 * Leave the strip in the configured state.
	 *
	 * Both commands go out immediately, on their own channels. No deferral and no
	 * waiting for a later turn - which is what makes this usable during shutdown,
	 * where there is no later turn.
	 */
	applyFallback(reason) {
		if (!this.fallback || this.fallbackApplied) { return; }

		this.fallbackApplied = true;
		if (this.fallback.mode === SHUTDOWN_LEAVE) { return; }

		if (this.fallback.mode === SHUTDOWN_OFF_ONLY) {
			this.send(lednetFrame([0x71, 0x24, 0x0F]));
			service.log("RGBeAll Bridge: powered off " + this.ip + " (" + reason + ")");
			return;
		}

		// Colour first: it is discarded if the strip is already off.
		const c = this.fallback.rgb;
		this.send(lednetFrame([0x31, c[0], c[1], c[2], 0x00, 0xF0, 0x0F]));

		if (this.fallback.mode === SHUTDOWN_RESTORE_AND_OFF) {
			this.send(lednetFrame([0x71, 0x24, 0x0F]));
		}

		service.log("RGBeAll Bridge: restored " + this.ip + " (" + reason + ")");
	}
}

/**
 * Destination guard.
 *
 * The relay socket accepts datagrams from the local machine. Restricting forwarding
 * to private address space stops it being used to reach arbitrary hosts, and the
 * command allowlist stops it being used to push arbitrary bytes at whatever happens
 * to be listening on port 5577.
 */
function isPrivateIPv4(a, b) {
	if (a === 10) { return true; }
	if (a === 192 && b === 168) { return true; }
	if (a === 172 && b >= 16 && b <= 31) { return true; }
	if (a === 127) { return true; }
	return false;
}

/** Decode an ASCII-hex relay datagram into a byte array. */
function decodeRelay(msg) {
	let text = null;

	if (msg && typeof msg.data === "string") { text = msg.data; }
	else if (typeof msg === "string") { text = msg; }

	if (text === null) { return null; }

	text = text.replace(/[^0-9A-Fa-f]/g, "");
	if (text.length === 0 || text.length % 2 !== 0 || text.length > 256) { return null; }

	const out = [];
	for (let i = 0; i < text.length; i += 2) {
		const v = parseInt(text.substr(i, 2), 16);
		if (isNaN(v)) { return null; }
		out.push(v);
	}
	return out;
}

export function DiscoveryService() {
	// Keep the framework defaults. Changing UdpListenPort/UdpBroadcastAddress stops
	// the discovery service registering at all.
	this.UdpBroadcastPort = 48899;
	this.UdpListenPort = 48899;
	this.UdpBroadcastAddress = "255.255.255.255";

	this.connections = {};
	this.relay = null;
	this.started = false;

	this.Initialize = function () {
		service.log("RGBeAll Bridge starting");
	};

	/**
	 * The relay socket is opened from Update rather than Initialize: handlers must be
	 * attached before bind(), and doing it on the first Update tick is the ordering
	 * that reliably ends up bound and receiving.
	 */
	this.startRelay = function () {
		const self = this;

		try {
			this.relay = udp.createSocket();
			this.relay.on("message", function (msg) { self.onRelayFrame(msg); });
			this.relay.on("error", function (e) { service.log("RGBeAll Bridge: relay socket error " + e); });
			this.relay.bind(RELAY_PORT);
			service.log("RGBeAll Bridge listening on " + RELAY_PORT);
		} catch (e) {
			service.log("RGBeAll Bridge FAILED to open relay port " + RELAY_PORT + ": " + e);
		}
	};

	this.onRelayFrame = function (msg) {
		const data = decodeRelay(msg);
		if (data === null) { return; }

		if (data.length <= RELAY_HEADER || data.length > 64) { return; }

		const kind = data[0];
		if (kind !== RELAY_MAGIC && kind !== RELAY_CONFIG) { return; }

		const a = data[1], b = data[2], c = data[3], d = data[4];
		if (!isPrivateIPv4(a, b)) { return; }

		const ip = a + "." + b + "." + c + "." + d;
		const payload = data.slice(RELAY_HEADER);

		let conn = this.connections[ip];
		if (!conn) {
			conn = new BridgeConnection(ip);
			this.connections[ip] = conn;
			conn.ensureConnected();
		}

		if (kind === RELAY_CONFIG) {
			if (payload.length < 5) { return; }

			const mode = payload[0];
			if (mode !== SHUTDOWN_LEAVE && mode !== SHUTDOWN_RESTORE &&
				mode !== SHUTDOWN_RESTORE_AND_OFF && mode !== SHUTDOWN_OFF_ONLY) { return; }

			conn.fallback = {
				mode: mode,
				rgb: [payload[1], payload[2], payload[3]],
				watchdogMs: payload[4] * 1000,
			};
			return;
		}

		if (ALLOWED_COMMANDS.indexOf(payload[0]) === -1) { return; }

		// A live frame means control is present again, so re-arm the fallback.
		const wasPoweredOff = conn.fallbackApplied && conn.fallback &&
			(conn.fallback.mode === SHUTDOWN_RESTORE_AND_OFF || conn.fallback.mode === SHUTDOWN_OFF_ONLY);

		conn.lastFrameAt = Date.now();
		conn.fallbackApplied = false;

		if (wasPoweredOff || conn.needsPowerOn) {
			// Either the watchdog switched the strip off, or this is the first frame over
			// a new connection and the strip may be off from a previous shutdown. Colour
			// commands are ignored while it is off, so power it on first.
			//
			// This cannot be left to the device half: it sends its own power-on in the
			// first few rendered frames, which race the relay socket being bound, so those
			// datagrams can land nowhere. Keying it to this connection instead makes it
			// reliable regardless of which side starts first.
			if (conn.needsPowerOn) { service.log("RGBeAll Bridge: powering " + conn.ip + " on for a new connection"); }
			conn.needsPowerOn = false;
			conn.send(lednetFrame([0x71, 0x23, 0x0F]));
			// That went out on the power channel, so this frame's colour can follow
			// immediately on the colour channel without sharing a packet with it.
		}

		conn.send(payload);
	};

	this.Update = function () {
		if (!this.started) {
			this.started = true;
			this.startRelay();
			return;
		}

		const now = Date.now();

		for (const ip in this.connections) {
			if (!Object.prototype.hasOwnProperty.call(this.connections, ip)) { continue; }
			const conn = this.connections[ip];

			// Watchdog: frames have stopped while SignalRGB is still running - the device
			// was disabled, or lighting was switched off. Leave the strip in a known state
			// rather than frozen on whatever frame landed last.
			if (conn.fallback && conn.fallback.watchdogMs > 0 && conn.lastFrameAt > 0 &&
				now - conn.lastFrameAt > conn.fallback.watchdogMs) {
				conn.applyFallback("no frames for " + Math.round((now - conn.lastFrameAt) / 1000) + "s");
			}

			if (now - conn.lastUsedAt > IDLE_CLOSE_MS) {
				// Nothing has rendered to this controller for a while; release the sockets.
				conn.close();
				delete this.connections[ip];
				service.log("RGBeAll Bridge: released idle connection to " + ip);
				continue;
			}

			conn.ensureConnected();
			conn.keepAlive();
		}
	};

	this.CheckForDevices = function () { };

	/**
	 * Last chance to leave the strip in a known state, and it has to be quick: Windows
	 * gives a process very little time once a shutdown starts. Both commands go out on
	 * their own channels in this one turn, so neither waits for anything.
	 */
	this.Shutdown = function () {
		for (const ip in this.connections) {
			if (!Object.prototype.hasOwnProperty.call(this.connections, ip)) { continue; }
			try {
				const conn = this.connections[ip];
				conn.fallbackApplied = false;
				conn.applyFallback("shutdown");
			} catch (e) { /* keep going */ }
		}

		// Deliberately not closing the sockets. Tearing them down here would discard
		// whatever was just written to them, which is precisely how a power-off gets
		// lost on a fast shutdown. They go away with the process.
	};
}
