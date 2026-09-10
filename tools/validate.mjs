/**
 * Offline validation for MagicHome.js.
 *
 * Loads the plugin outside SignalRGB, then asserts the protocol layer against byte
 * sequences captured from real hardware and checks that untrusted network input is
 * rejected. No device, no network and no dependencies required.
 *
 *   node tools/validate.mjs
 *
 * Exits non-zero if anything fails, so it can be wired into CI.
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const src_path = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", "MagicHome.js");
const tmp_path = path.join(tmpdir(), `magichome.validate.${process.pid}.mjs`);

let source = await readFile(src_path, "utf8");

// The @SignalRGB/* modules only exist inside the application.
source = source.replace(/^import .*$/gm, "");
// Surface module-private helpers so they can be asserted.
source += `\nexport { LEDNET, parseDiscoveryReply, isValidIPv4, clampByte, hexToRgb, GAMMA_TABLE };\n`;

await writeFile(tmp_path, source, "utf8");

let plugin;
try {
	plugin = await import(pathToFileURL(tmp_path).href);
} catch (err) {
	console.error("FAILED TO LOAD PLUGIN\n" + err.stack);
	await unlink(tmp_path).catch(() => {});
	process.exit(1);
}

const { LEDNET, parseDiscoveryReply, isValidIPv4, clampByte, hexToRgb, GAMMA_TABLE } = plugin;

let passed = 0;
let failed = 0;

const toHex = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

function check(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed++;
		console.log(`  ok    ${label}`);
	} else {
		failed++;
		console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
	}
}

function checkFrame(label, actual, expectedHex) {
	const a = toHex(actual);
	if (a === expectedHex) {
		passed++;
		console.log(`  ok    ${label.padEnd(26)} ${a}`);
	} else {
		failed++;
		console.log(`  FAIL  ${label}\n          expected ${expectedHex}\n          actual   ${a}`);
	}
}

console.log("\n-- plugin surface --");
for (const fn of ["Name", "Version", "Type", "Publisher", "Size", "LedNames", "LedPositions",
	"ControllableParameters", "Initialize", "Render", "Shutdown", "DiscoveryService"]) {
	if (typeof plugin[fn] === "function") { passed++; console.log(`  ok    ${fn}()`); }
	else { failed++; console.log(`  FAIL  ${fn}() is missing`); }
}
check("Type() is 'network'", plugin.Type(), "network");
check("LedNames matches LedPositions", plugin.LedNames().length, plugin.LedPositions().length);

console.log("\n-- protocol frames (vs hardware capture) --");
checkFrame("setColour(255,0,0)", LEDNET.setColour(255, 0, 0), "31 FF 00 00 00 F0 0F 2F");
checkFrame("setColour(0,255,0)", LEDNET.setColour(0, 255, 0), "31 00 FF 00 00 F0 0F 2F");
checkFrame("setColour(0,0,255)", LEDNET.setColour(0, 0, 255), "31 00 00 FF 00 F0 0F 2F");
checkFrame("setColour(0,0,0)", LEDNET.setColour(0, 0, 0), "31 00 00 00 00 F0 0F 30");
checkFrame("setColour(255,255,255)", LEDNET.setColour(255, 255, 255), "31 FF FF FF 00 F0 0F 2D");
checkFrame("powerOn()", LEDNET.powerOn(), "71 23 0F A3");
checkFrame("powerOff()", LEDNET.powerOff(), "71 24 0F A4");
checkFrame("queryState()", LEDNET.queryState(), "81 8A 8B 96");

console.log("\n-- checksum rule holds for responses --");
const response = [0x81, 0x33, 0x23, 0x61, 0x01, 0x01, 0xFF, 0x00, 0x00, 0x00, 0x04, 0x00, 0xF0];
check("state response checksum", response.reduce((a, b) => a + b, 0) & 0xFF, 0x2D);

console.log("\n-- byte clamping --");
check("clampByte(-5)", clampByte(-5), 0);
check("clampByte(999)", clampByte(999), 255);
check("clampByte(NaN)", clampByte(NaN), 0);
check("clampByte(Infinity)", clampByte(Infinity), 0);
check("clampByte(12.6) rounds", clampByte(12.6), 13);
check("wild input never leaves byte range",
	LEDNET.setColour(clampByte(-1), clampByte(300), clampByte(NaN)).every((b) => b >= 0 && b <= 255), true);

console.log("\n-- hexToRgb --");
check("hexToRgb('#FF8000')", hexToRgb("#FF8000"), [255, 128, 0]);
check("hexToRgb without hash", hexToRgb("009bde"), [0, 155, 222]);
check("hexToRgb(garbage)", hexToRgb("not-a-colour"), [0, 0, 0]);
check("hexToRgb(undefined)", hexToRgb(undefined), [0, 0, 0]);

console.log("\n-- isValidIPv4 (range, not just shape) --");
check("accepts 192.0.2.50", isValidIPv4("192.0.2.50"), true);
check("accepts 0.0.0.0", isValidIPv4("0.0.0.0"), true);
check("accepts 255.255.255.255", isValidIPv4("255.255.255.255"), true);
check("rejects 999.1.1.1", isValidIPv4("999.1.1.1"), false);
check("rejects too few octets", isValidIPv4("1.2.3"), false);
check("rejects too many octets", isValidIPv4("1.2.3.4.5"), false);
check("rejects empty", isValidIPv4(""), false);
check("rejects null", isValidIPv4(null), false);
check("rejects trailing junk", isValidIPv4("1.2.3.4; whoami"), false);

console.log("\n-- parseDiscoveryReply (untrusted network input) --");
check("accepts a valid reply", parseDiscoveryReply("192.0.2.50,A1B2C3D4E5F6,EXAMPLE-MODEL"),
	{ ip: "192.0.2.50", mac: "A1B2C3D4E5F6", model: "EXAMPLE-MODEL", manual: false });
check("tolerates whitespace, upper-cases mac",
	parseDiscoveryReply(" 192.0.2.50 , a1b2c3d4e5f6 , TESTMODEL \r\n").mac, "A1B2C3D4E5F6");
check("rejects non-string", parseDiscoveryReply(null), null);
check("rejects number", parseDiscoveryReply(12345), null);
check("rejects empty", parseDiscoveryReply(""), null);
check("rejects two fields", parseDiscoveryReply("192.0.2.50,A1B2C3D4E5F6"), null);
check("rejects four fields", parseDiscoveryReply("192.0.2.50,A1B2C3D4E5F6,X,Y"), null);
check("rejects bad ip", parseDiscoveryReply("999.1.1.1,A1B2C3D4E5F6,TESTMODEL"), null);
check("rejects short mac", parseDiscoveryReply("192.0.2.50,A1B2C3,TESTMODEL"), null);
check("rejects non-hex mac", parseDiscoveryReply("192.0.2.50,ZZZZZZZZZZZZ,TESTMODEL"), null);
check("rejects oversized payload",
	parseDiscoveryReply("192.0.2.50,A1B2C3D4E5F6," + "A".repeat(200)), null);
check("rejects markup in model", parseDiscoveryReply("192.0.2.50,A1B2C3D4E5F6,<img src=x>"), null);
check("rejects quotes in model", parseDiscoveryReply('192.0.2.50,A1B2C3D4E5F6,"onerror'), null);
check("rejects over-long model",
	parseDiscoveryReply("192.0.2.50,A1B2C3D4E5F6," + "A".repeat(40)), null);

console.log("\n-- gamma table --");
check("maps 0 to 0", GAMMA_TABLE[0], 0);
check("maps 255 to 255", GAMMA_TABLE[255], 255);
check("is monotonic", GAMMA_TABLE.every((v, i, a) => i === 0 || v >= a[i - 1]), true);
check("darkens midtones", GAMMA_TABLE[128] < 128, true);

await unlink(tmp_path).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
