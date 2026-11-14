import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/app/manifest";

describe("PWA manifest and icons", () => {
  it("keeps installation identity and navigation within the app", () => {
    expect(manifest()).toMatchObject({
      id: "/",
      name: "Webcards",
      short_name: "Webcards",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f4f2e9",
      theme_color: "#183e34",
    });
  });

  it("ships real PNG icons at every declared size, including a maskable icon", () => {
    const icons = manifest().icons!;
    expect(icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
      ]),
    );
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      const png = readFileSync(
        new URL(`../public${icon.src}`, import.meta.url),
      );
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(
        icon.sizes,
      );
    }
    const apple = readFileSync(
      new URL("../public/icons/apple-touch-icon.png", import.meta.url),
    );
    expect([apple.readUInt32BE(16), apple.readUInt32BE(20)]).toEqual([
      180, 180,
    ]);
  });
});
