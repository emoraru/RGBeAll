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
export function Version() { return "1.1.0"; }
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
//   byte 0      magic 0x52
//   bytes 1-4   destination IPv4, one octet per byte
//   bytes 5+    raw LEDNET frame, forwarded verbatim
// ---------------------------------------------------------------------------

const RELAY_PORT = 41577;
const RELAY_MAGIC = 0x52;
const RELAY_HEADER = 5;
const LEDNET_PORT = 5577;

// Only these LEDNET commands are ever forwarded.
const ALLOWED_COMMANDS = [0x31, 0x41, 0x71, 0x81];

// Qt's QAbstractSocket::ConnectedState
const STATE_CONNECTED = 3;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const IDLE_CLOSE_MS = 120000;

/** One TCP connection to one controller, with reconnect backoff. */
class BridgeConnection {
	constructor(ip) {
		this.ip = ip;
		this.socket = null;
		this.ready = false;
		this.connecting = false;
		this.failures = 0;
		this.nextAttemptAt = 0;
		this.lastUsedAt = Date.now();
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

	ensureConnected() {
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
				service.log("Bridge: connected to " + self.ip);
			};
			const down = function () {
				if (self.ready) { service.log("Bridge: connection to " + self.ip + " closed"); }
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
				service.log("Bridge: socket error for " + self.ip + ": " + e);
				self.ready = false;
				self.connecting = false;
				self.scheduleRetry();
			});
			// The controller acknowledges every command. Consume and discard, never read
			// synchronously - that is what makes the frame-desync trap impossible here.
			this.on("message", function () { });

			this.socket.connect(this.ip, LEDNET_PORT);
		} catch (e) {
			this.connecting = false;
			service.log("Bridge: connect failed for " + this.ip + ": " + e);
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

	send(bytes) {
		this.lastUsedAt = Date.now();

		if (!this.isReady()) {
			this.ensureConnected();
			return false;   // dropped while connecting; the next frame arrives in ~33ms
		}

		try {
			this.socket.send(bytes);
			return true;
		} catch (e) {
			service.log("Bridge: send failed for " + this.ip + ": " + e);
			this.ready = false;
			this.scheduleRetry();
			return false;
		}
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
			this.relay.on("error", function (e) { service.log("Bridge: relay socket error " + e); });
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
		if (data[0] !== RELAY_MAGIC) { return; }

		const a = data[1], b = data[2], c = data[3], d = data[4];
		if (!isPrivateIPv4(a, b)) { return; }

		const payload = data.slice(RELAY_HEADER);
		if (ALLOWED_COMMANDS.indexOf(payload[0]) === -1) { return; }

		const ip = a + "." + b + "." + c + "." + d;
		let conn = this.connections[ip];

		if (!conn) {
			conn = new BridgeConnection(ip);
			this.connections[ip] = conn;
			conn.ensureConnected();
			return;   // the first frame primes the connection
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

			if (now - conn.lastUsedAt > IDLE_CLOSE_MS) {
				// Nothing has rendered to this controller for a while; release the socket.
				conn.close();
				delete this.connections[ip];
				service.log("Bridge: released idle connection to " + ip);
				continue;
			}

			conn.ensureConnected();
		}
	};

	this.CheckForDevices = function () { };

	this.Shutdown = function () {
		for (const ip in this.connections) {
			if (Object.prototype.hasOwnProperty.call(this.connections, ip)) {
				this.connections[ip].close();
			}
		}
		this.connections = {};
		try { if (this.relay) { this.relay.close(); } } catch (e) { /* already gone */ }
	};
}
