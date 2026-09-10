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
export function Version() { return "1.2.0"; }
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

// Qt's QAbstractSocket::ConnectedState
const STATE_CONNECTED = 3;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const IDLE_CLOSE_MS = 120000;

// The controller acts on only the FIRST LEDNET command in a packet - verified by
// sending a colour and a power-off concatenated, where the power-off was ignored.
//
// That is a packeting rule, not a timing one. Two separate write() calls always land,
// even with no gap between them; only a single write carrying both commands fails.
// The catch is that Qt buffers writes and flushes once per turn of the event loop, so
// two sends in the SAME turn still leave as one packet. Commands therefore have to be
// issued from different turns - and no delay is needed beyond that.
//
// The fast path costs nothing: RGBeAll.js sends its shutdown colour and power-off as
// two separate datagrams, which arrive as two separate relay callbacks, so they are
// already in different turns and go out as two packets immediately.
//
// Only sequences this file generates itself (the watchdog) need help, and they use a
// single deferred slot drained on the next turn.

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

		// One command held back because it must not share a packet with the last one.
		this.deferred = null;

		// Set from the config channel; null until RGBeAll.js has told us what to do.
		this.fallback = null;
		this.lastFrameAt = 0;
		this.fallbackApplied = false;
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
				service.log("RGBeAll Bridge: connected to " + self.ip);
			};
			const down = function () {
				if (self.ready) { service.log("RGBeAll Bridge: connection to " + self.ip + " closed"); }
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
				service.log("RGBeAll Bridge: socket error for " + self.ip + ": " + e);
				self.ready = false;
				self.connecting = false;
				self.scheduleRetry();
			});

			// Acks are never parsed - no synchronous read ever happens here, so the
			// frame-desync trap in docs/PROTOCOL.md cannot occur. An ack does arrive on
			// its own turn though, which makes it a good moment to release anything held.
			this.on("message", function () { self.drainDeferred(); });

			this.socket.connect(this.ip, LEDNET_PORT);
		} catch (e) {
			this.connecting = false;
			service.log("RGBeAll Bridge: connect failed for " + this.ip + ": " + e);
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
		this.deferred = null;
	}

	/** Write one LEDNET command. Each call is its own packet, provided callers do not
	 * issue two in the same turn of the event loop. */
	send(frame) {
		this.lastUsedAt = Date.now();

		if (!this.isReady()) {
			this.ensureConnected();
			return false;
		}

		try {
			this.socket.send(frame);
			return true;
		} catch (e) {
			service.log("RGBeAll Bridge: send failed for " + this.ip + ": " + e);
			this.ready = false;
			this.scheduleRetry();
			return false;
		}
	}

	/** Hold a command back so it lands in its own packet on a later turn. */
	defer(frame) {
		this.deferred = frame;
	}

	/** Send whatever was held back. Called from any later turn. */
	drainDeferred() {
		if (this.deferred === null) { return; }
		const frame = this.deferred;
		this.deferred = null;
		this.send(frame);
	}

	/**
	 * Leave the strip in the configured state.
	 *
	 * The controller persists colour in non-volatile storage and reloads it on power-on,
	 * so this decides what the strip shows next time it is switched on by hand. The
	 * colour goes out now and the power-off is held for the next turn, so the two do
	 * not share a packet - the controller would act on only the first.
	 */
	applyFallback(reason) {
		if (!this.fallback || this.fallbackApplied) { return; }

		this.fallbackApplied = true;
		if (this.fallback.mode === SHUTDOWN_LEAVE) { return; }

		// A single command cannot share a packet with anything, so this path has no
		// ordering problem at all - which is why it is the reliable one.
		if (this.fallback.mode === SHUTDOWN_OFF_ONLY) {
			this.send(lednetFrame([0x71, 0x24, 0x0F]));
			service.log("RGBeAll Bridge: powered off " + this.ip + " (" + reason + ")");
			return;
		}

		const c = this.fallback.rgb;
		this.send(lednetFrame([0x31, c[0], c[1], c[2], 0x00, 0xF0, 0x0F]));

		if (this.fallback.mode === SHUTDOWN_RESTORE_AND_OFF) {
			this.defer(lednetFrame([0x71, 0x24, 0x0F]));
		}

		service.log("RGBeAll Bridge: restoring " + this.ip + " (" + reason + ")");
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

		if (wasPoweredOff) {
			// The watchdog had switched the strip off. Power it back on and let the next
			// frame carry the colour - sending both here would put them in one packet.
			conn.send(lednetFrame([0x71, 0x23, 0x0F]));
			service.log("RGBeAll Bridge: control resumed, powering " + conn.ip + " back on");
			return;
		}

		// Any command held back from a previous turn goes first, in its own packet.
		if (conn.deferred !== null) {
			conn.drainDeferred();
			return;
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

			// Release anything held back, in case no relay frame has arrived since.
			conn.drainDeferred();

			// Watchdog: frames have stopped while SignalRGB is still running - the device
			// was disabled, or lighting was switched off. Leave the strip in a known state
			// rather than frozen on whatever frame landed last.
			if (conn.fallback && conn.fallback.watchdogMs > 0 && conn.lastFrameAt > 0 &&
				now - conn.lastFrameAt > conn.fallback.watchdogMs) {
				conn.applyFallback("no frames for " + Math.round((now - conn.lastFrameAt) / 1000) + "s");
			}

			if (now - conn.lastUsedAt > IDLE_CLOSE_MS) {
				// Nothing has rendered to this controller for a while; release the socket.
				conn.close();
				delete this.connections[ip];
				service.log("RGBeAll Bridge: released idle connection to " + ip);
			}
		}
	};

	this.CheckForDevices = function () { };

	/**
	 * Last chance to leave the strip in a known state, and it has to be quick: Windows
	 * gives a process very little time once a shutdown starts. RGBeAll.js attempts the
	 * same thing from its own Shutdown, but there is no guarantee which side runs first,
	 * and this side owns the socket.
	 */
	this.Shutdown = function () {
		for (const ip in this.connections) {
			if (!Object.prototype.hasOwnProperty.call(this.connections, ip)) { continue; }
			try {
				const conn = this.connections[ip];
				conn.fallbackApplied = false;
				conn.applyFallback("shutdown");
				// No later turn is coming, so release the power-off immediately. Qt may
				// coalesce it with the colour into one packet, in which case only the
				// colour lands - which is the half that decides what the strip shows when
				// it is next switched on. RGBeAll.js sends the same pair as two separate
				// datagrams, which do arrive on separate turns, so that path gets both.
				conn.drainDeferred();
			} catch (e) { /* keep going */ }
		}

		// Deliberately not closing the sockets. Tearing them down here would discard
		// whatever was just written to them, which is precisely how a power-off gets
		// lost on a fast shutdown. They go away with the process.
	};
}
