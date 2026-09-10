# Protocol test vectors

Known-good byte sequences captured from real hardware. Use these to verify any implementation of
the LEDNET framing before touching a device.

The framing rule is one line: **`checksum = (sum of all preceding bytes) & 0xFF`**.

## Commands

| Call | Expected bytes |
|---|---|
| `setColour(255, 0, 0)` | `31 FF 00 00 00 F0 0F 2F` |
| `setColour(0, 255, 0)` | `31 00 FF 00 00 F0 0F 2F` |
| `setColour(0, 0, 255)` | `31 00 00 FF 00 F0 0F 2F` |
| `setColour(0, 0, 0)` | `31 00 00 00 00 F0 0F 30` |
| `setColour(255, 255, 255)` | `31 FF FF FF 00 F0 0F 2D` |
| `powerOn()` | `71 23 0F A3` |
| `powerOff()` | `71 24 0F A4` |
| `queryState()` | `81 8A 8B 96` |

Note that the three primary-colour frames share checksum `2F`. That is correct, not a mistake — the
sum is identical regardless of which channel carries the `0xFF`. It is also a good reminder that
this checksum detects corruption, not transposition.

## State response

A 14-byte reply representing an analog RGB controller, powered on, static mode, showing full red:

```
81 33 23 61 01 01 FF 00 00 00 04 00 F0 2D
```

| Offset | Value | Meaning |
|---|---|---|
| 0 | `81` | response header — **always** `0x81`; reject anything else |
| 1 | `33` | device type: analog RGB controller |
| 2 | `23` | power on (`0x24` would be off) |
| 3 | `61` | static colour mode |
| 6 | `FF` | red |
| 7 | `00` | green |
| 8 | `00` | blue |
| 9 | `00` | warm white |
| 11 | `00` | cold white |
| 12 | `F0` | colour mode: RGB only |
| 13 | `2D` | checksum |

The same checksum rule applies to responses, so it can be used to validate a read.

## Acknowledgements

Easy to overlook and the cause of the most confusing failure mode in this protocol — see
[PROTOCOL.md](../docs/PROTOCOL.md#the-acknowledgement-trap).

| After sending | Controller returns |
|---|---|
| `31 ...` set colour | `30` (1 byte) |
| `71 ...` power | `F0 71 23 84` (4 bytes) |
| `81 8A 8B 96` query | 14 bytes, header `0x81` |

## Discovery

Broadcast on UDP 48899:

```
HF-A11ASSISTHREAD
```

Reply shape:

```
<ipv4>,<12-hex-mac>,<module-model>
```

Reject any reply that does not split into exactly three fields, or whose IPv4 octets fall outside
0-255, or whose MAC is not exactly 12 hex characters. Replies are unauthenticated broadcasts and
anything on the network can forge one.
