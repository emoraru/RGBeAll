# Security assessment

Two separate things are worth assessing here, and it helps to keep them apart:

1. **The controller and its protocol** — where the real weaknesses are, none of which a plugin can fix
2. **This plugin** — what it does, what it deliberately does not do, and its attack surface

---

## Summary

| | Risk | Fixable here? |
|---|---|---|
| F-1 | Control channel has no authentication or encryption | No — protocol design |
| F-2 | Unauthenticated AT command interface allows reboot and network reconfiguration | No — firmware design |
| F-3 | Unpatched 2017 firmware with a persistent outbound cloud connection | Partially, by network policy |
| F-4 | Discovery replies are forgeable network input | **Yes** — mitigated in this plugin |

The honest bottom line: **this class of device is not trustworthy on a flat network.** Installing
this plugin does not make that worse — the exposure already exists the moment the controller is
powered on, and the vendor app relies on exactly the same unauthenticated channels. But if you are
going to run these devices, put them on an isolated network segment.

---

## Device and protocol findings

### F-1 — No authentication or encryption on the control channel

Colour and power control is plaintext TCP on port 5577. There is no handshake, no pairing, no token,
no session. Any host that can route to the controller can take full control of it.

**Impact.** Low in isolation — an attacker changes your lighting. It matters more as a *signal*:
a device with no authentication on its control plane is unlikely to be hardened elsewhere, and F-2
shows that is the case.

**Mitigation.** Not possible in software on the client side. Restrict at the network layer.

### F-2 — Unauthenticated AT command interface

UDP port 48899 exposes an AT command interface with no authentication. It answers a broadcast
handshake and then accepts configuration commands, including device reboot and Wi-Fi/network
reconfiguration.

**Impact.** Meaningfully higher than F-1. Anyone on the LAN can reboot the device persistently, or
repoint its network configuration. This is a denial-of-service primitive at minimum.

**Mitigation.** Network isolation only. Nothing can be done from the client side.

**Note on discovery.** The standard discovery handshake — broadcasting `HF-A11ASSISTHREAD` — is also
what places these modules into AT command mode on that socket. Every tool in this ecosystem
discovers devices this way, and it is harmless in ordinary use, but it is a state change rather than
a pure read. Documented here rather than buried. If you would rather not send it at all, add your
controller by IP instead and discovery never runs.

### F-3 — Unpatched firmware, persistent cloud connection

The firmware tested was built in 2017 and has no practical update path. It also maintains an
outbound connection to the vendor's cloud service so the phone app can reach it from outside the
home network.

**Impact.** An internet-reachable control path exists that you do not control and cannot audit. The
device is also nine years unpatched against anything found in that time.

**Mitigation.** Local control does not need the cloud — everything this plugin does works with the
device's internet access blocked entirely. Blocking outbound traffic from the device at your router
removes the remote path while keeping the plugin fully functional. You lose the phone app when away
from home.

---

## This plugin

### What it does

- Opens **two** TCP connections to a controller you configure, on port 5577 - one carries colour,
  the other power. They are separate so a colour and a power-off cannot end up in the same packet,
  which the controller would otherwise truncate. See [PROTOCOL.md](PROTOCOL.md).
- Sends colour and power commands
- Optionally broadcasts the discovery string on UDP 48899 to find controllers

### What it deliberately does not do

- **Never issues AT commands.** No reboot, no configuration writes, no firmware interaction.
- **Never modifies device configuration.** Colour and power only.
- **No cloud, no telemetry, no analytics, no outbound internet traffic of any kind.**
- **No credentials.** The protocol has none, so there is nothing to store or leak.
- **No third-party dependencies.** No supply-chain surface beyond SignalRGB itself.
- **No dynamic code evaluation** — no `eval`, no `Function()` constructor, no remote code loading.
- **No filesystem access** beyond SignalRGB's own settings store, which holds only IP addresses.

### F-4 — Untrusted discovery input (mitigated)

Discovery replies arrive as UDP broadcasts. Anything on the network can forge one, so they are
treated as hostile input rather than as trusted device data.

`parseDiscoveryReply()` in [`RGBeAll.js`](../RGBeAll.js) enforces, in order:

1. type check — must be a string
2. length bound — rejected above 128 bytes, before any parsing work is done
3. exact field count — must split into exactly three comma-separated fields
4. strict per-field validation:
   - IPv4 against a digit-group pattern **with octet range checks** (rejects `999.1.1.1`)
   - MAC against exactly 12 hex characters
   - model against a conservative `[A-Za-z0-9._-]{1,32}` allowlist

Anything failing any check is dropped silently. The model string is the one field that reaches the
UI, which is why it is restricted to an allowlist rather than merely length-checked.

Manually entered IP addresses go through the same `isValidIPv4()` check before use, and the stored
list is re-validated on load — so a hand-edited settings file cannot inject an arbitrary string into
a connection attempt.

### F-5 - The bridge listens on a local UDP relay port (new in 1.1.0)

`RGBeAllBridge.js` binds UDP port **41577** to receive frames from the rendering half of the
plugin. Qt binds it on `0.0.0.0`, not just loopback, so other hosts on the LAN can reach it.

**Impact.** Someone on your network could send relay datagrams and change your lighting. They
could already do that by talking to the controller directly (F-1), so this adds no capability they
lacked - but it is new listening surface that would not otherwise exist, and it is worth knowing
about.

**Mitigations in place.** The bridge is deliberately not a general-purpose forwarder:

- datagrams must carry the `0x52` magic byte and decode as valid ASCII hex
- payloads are bounded (rejected above 64 bytes decoded, 256 characters on the wire)
- destinations are restricted to **private IPv4 ranges only** - it cannot be used to reach a public
  host, so it is not usable as an SSRF or reflection primitive
- only four LEDNET commands are forwarded (`0x31`, `0x41`, `0x71`, `0x81`), so it cannot be used to
  push arbitrary bytes at whatever else may be listening on port 5577

**If you would rather not have it at all:** the bridge is only needed because SignalRGB does not
expose TCP to the device context. Deleting `RGBeAllBridge.js` removes the listener and disables
colour control, leaving the rest of the plugin inert.

### Residual risk in the plugin

- **A forged discovery reply can still cause a connection attempt to an attacker-chosen LAN IP.**
  The payload is well-formed but points somewhere else. Impact is limited to the plugin opening a
  TCP connection and writing 8-byte colour frames to it. It cannot leak anything — the plugin holds
  no secrets and sends only colour values. Adding controllers by IP avoids this entirely.
- **Denial of service.** An attacker on the LAN can already control or reboot the controller
  directly (F-1, F-2). The plugin neither adds to nor reduces this.

---

## Recommendations

In rough order of value:

1. **Put IoT devices on their own VLAN or guest network**, with a firewall rule allowing only your
   PC to reach the controller. This addresses F-1 and F-2, which are otherwise unaddressable.
2. **Give the controller a DHCP reservation.** Its address is then stable, so you can add it by IP
   and never run broadcast discovery.
3. **Block the controller's outbound internet access** if you do not need the phone app away from
   home. Removes the F-3 remote path with no loss of plugin functionality.
4. **Prefer manual IP entry over discovery.** Removes F-4 and the AT-mode side effect entirely.

---

## Reporting a problem

If you find a security issue in this plugin, please open an issue on the repository. Since the
plugin holds no credentials and speaks only to a device on your own network, the realistic severity
ceiling is low — but reports are welcome regardless.

Weaknesses in the controller firmware itself are the vendor's, not this project's, and are
documented here so you can make an informed decision about running the hardware at all.
