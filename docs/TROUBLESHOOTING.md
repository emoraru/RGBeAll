# Troubleshooting

Start by running the probe tool — it answers most of these questions directly from the hardware:

```powershell
.\tools\rgbeall-probe.ps1 -Ip 192.0.2.50
```

---

## The controller does not appear in SignalRGB

**Add it by IP instead of waiting for discovery.** Open the Magic Home settings panel under Third
Party Services, type the controller's address and click Add. Manual entry is the reliable path and
always available.

Broadcast discovery fails on plenty of normal networks:

- **Client isolation / AP isolation** is enabled on the Wi-Fi network, so broadcasts do not reach
  wireless clients. Common on mesh systems and guest networks by default.
- **PC and controller are on different subnets** or different VLANs. Broadcasts do not cross subnets.
- **Windows Firewall** is blocking inbound UDP 48899 for SignalRGB.
- **The PC is on Wi-Fi and the controller is on a different band or SSID** that the router bridges
  without forwarding broadcast traffic.

If the probe tool reaches the controller but SignalRGB does not find it, discovery is the problem,
not the device. Use manual entry.

## The device appears but never connects

Check port 5577 is actually reachable:

```powershell
.\tools\rgbeall-probe.ps1 -Ip 192.0.2.50
```

- **`CLOSED/FILTERED`** — a firewall is in the way, or the address is wrong, or the device is a
  newer model that does not expose the legacy port.
- **Reachable but no state response** — most likely a newer encrypted-firmware unit. This plugin
  cannot drive it. See [PROTOCOL.md](PROTOCOL.md#identifying-your-controller).
- **The controller's IP changed.** These devices take a DHCP lease like anything else. Set a DHCP
  reservation on your router.

## The strip lights up but ignores effects

- **Lighting Mode is set to Forced.** Switch it to Canvas.
- **The device box is outside the effect area** on the SignalRGB layout canvas. Drag it over the
  region you want it to sample.
- **The effect is black at that point.** Some effects only paint part of the canvas.

## Colours are wrong

- **Everything looks washed out or grey.** You are on `Average` sampling with a gradient effect
  spread across the device box. Averaging a rainbow gives grey — that is arithmetic, not a bug.
  Switch to `Centre`.
- **Colours are too intense compared to case lighting.** Lower `Max Brightness`. Analog strips are
  usually far brighter than in-case RGB.
- **Dim colours look wrong or crushed.** Make sure `Gamma Correction` is on.
- **Red and green appear swapped.** Unlikely — the protocol channel order is fixed and verified. Some
  enclosures are silkscreened `G R B`, which is the *physical pin order on the connector*, not a byte
  order. If your strip genuinely shows the wrong colour, the strip is wired to the header in a
  non-standard order; rewire it rather than working around it in software, or the phone app will be
  wrong too.

## The strip stutters or lags

- **Lower the frame rate cap.** 30 FPS is comfortable on the hardware tested, but Wi-Fi conditions
  vary. Try 20, then 15.
- **Weak Wi-Fi signal** at the controller. These modules have small antennas and are often installed
  behind a desk or inside furniture.
- **Congested 2.4 GHz band.** These controllers are 2.4 GHz only.

## The strip briefly flashes the wrong colour when SignalRGB starts

Expected, and already minimised. Powering the controller on makes it reload its last saved colour
from non-volatile storage; the plugin writes the real colour immediately afterwards. A brief flash
during connection is normal.

## The phone app stopped working

Close SignalRGB and check again. These controllers accept a limited number of concurrent
connections, so the app and the plugin can compete for one. Deciding which one owns the strip at a
given time is the simplest fix.

## Effects look nothing like they do on my case RGB

This is the hardware, not a fault. An analog controller has **one colour zone** — the entire strip
is always a single colour. Rainbow *waves*, ripples, comets and rain all collapse into the whole
strip changing colour together.

Effects that work well: colour cycles, breathing, static colours, audio level meters, screen ambience.

For genuine per-LED effects you need addressable hardware, which is a strip and controller swap — see
the README's scope section.

## Getting more detail

SignalRGB writes logs to:

```
%LOCALAPPDATA%\WhirlwindFX\SignalRgb\Logs\
```

Files are named `SignalRGB_<date>_<time>.log`; the newest one is the current session. To follow it
live while reproducing a problem:

```powershell
$log = Get-ChildItem "$env:LOCALAPPDATA\WhirlwindFX\SignalRgb\Logs\*.log" |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $log.FullName -Wait -Tail 40 | Select-String -Pattern 'MagicHome','Magic Home'
```

The plugin logs connection attempts, socket errors and discovery results. Include the relevant lines
if you open an issue — but **check them for your IP and MAC addresses first** if you would rather not
publish those.

## "Could not open module @SignalRGB/tcp" in the device console

You are missing `RGBeAllBridge.js`, or it failed to load. Both files must be present:

```
RGBeAll.js         renders and sends frames
RGBeAllBridge.js   holds the TCP connection to the controller
RGBeAll.qml        settings panel
```

If `RGBeAll.js` still contains `import tcp from "@SignalRGB/tcp"`, you have an old copy from
before 1.1.0 — that import fails in the render context and the device never sends anything. Update
both files together.

## The device links but the strip never changes colour

The relay between the two files is not connecting. In order:

1. **Check both plugin files are installed** and SignalRGB has been fully restarted (quit from the
   tray, not just closing the window).
2. **Check UDP port 41577 is free.** The bridge binds it; if something else already holds it, the
   relay silently receives nothing:
   ```powershell
   Get-NetUDPEndpoint -LocalPort 41577 -ErrorAction SilentlyContinue |
     Select-Object LocalAddress,LocalPort,OwningProcess
   ```
   The owning process should be `SignalRgb`. If it is something else, stop that program.
3. **Confirm the controller itself is reachable** with `tools\rgbeall-probe.ps1 -Ip <address>`.

## The strip turns itself off while I am using the PC

The takeover watchdog fired: RGBeAll stopped receiving frames for longer than **Takeover Timeout**,
so it restored the colour and powered the strip off. That is intentional — it means control was
lost rather than the strip being left frozen on a random effect frame.

Usual causes: the device was disabled in SignalRGB, lighting was switched off, or the plugin errored.
If frames start again the strip powers back on automatically.

To stop it happening, set **Takeover Timeout** to `0`, or set **When SignalRGB stops** to
`Leave as-is`.

## The strip does not go back to my colour after shutting the PC down

Check **When SignalRGB stops** is not set to `Leave as-is`, and that **Restore Colour** is what you
expect.

If it is configured correctly and the strip still keeps its last effect colour, SignalRGB was almost
certainly terminated rather than closed — a crash, Task Manager, or a power cut. Nothing inside the
plugin runs in that case, so the strip keeps whatever colour it last received. The next normal
shutdown will restore it again.
