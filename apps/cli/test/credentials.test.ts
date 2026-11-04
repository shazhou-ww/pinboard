import { PassThrough, Readable, Writable } from "node:stream";
import type { ReadStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import { credentials, hiddenToken, stdinToken } from "../src/credentials.js";
import { Store } from "../src/store.js";
import { CliError } from "../src/errors.js";

const signal = () => new AbortController().signal;
describe("non-echoing token readers", () => {
  it("uses only the selected endpoint and explicitly reports missing credentials", async () => {
    const store = new Store("not-read");
    const read = vi
      .spyOn(store, "token")
      .mockResolvedValueOnce("synthetic-local")
      .mockResolvedValueOnce(undefined);
    expect(
      await credentials(
        store,
        "https://one",
        {},
        false,
        Readable.from([]),
        signal(),
      ),
    ).toBe("synthetic-local");
    expect(read).toHaveBeenCalledWith("https://one");
    await expect(
      credentials(store, "https://two", {}, false, Readable.from([]), signal()),
    ).rejects.toMatchObject({ code: "TOKEN_REQUIRED" });
  });
  it("bounds and cancels stdin and does not silently trim whitespace", async () => {
    await expect(
      stdinToken(Readable.from(["x".repeat(4099)]), signal()),
    ).rejects.toMatchObject({ code: "TOKEN_INPUT" });
    await expect(
      stdinToken(Readable.from([" token\n"]), signal()),
    ).rejects.toMatchObject({ code: "USAGE" });
    await expect(
      stdinToken(Readable.from(["\n"]), signal()),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(await stdinToken(Readable.from(["synthetic\r\n"]), signal())).toBe(
      "synthetic",
    );
    const input = new PassThrough();
    const controller = new AbortController();
    const pending = stdinToken(input, controller.signal);
    controller.abort(new CliError("INTERRUPTED", "Interrupted", 130));
    await expect(pending).rejects.toMatchObject({ exitCode: 130 });
    expect(input.listenerCount("data")).toBe(0);
    const failed = new PassThrough();
    const failure = stdinToken(failed, signal());
    failed.emit("error", new Error("sensitive diagnostic"));
    await expect(failure).rejects.toMatchObject({ code: "TOKEN_INPUT" });
  });
  it("requires a TTY unless stdin was explicitly selected", async () => {
    await expect(
      hiddenToken(
        new PassThrough() as unknown as ReadStream,
        new PassThrough(),
        signal(),
      ),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
  it("restores terminal mode and never echoes characters (terminal adapter test)", async () => {
    let text = "";
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
    });
    const pending = hiddenToken(
      input as unknown as ReadStream,
      output,
      signal(),
    );
    input.emit("data", Buffer.from("syntheticX\u007f-token\r"));
    expect(await pending).toBe("synthetic-token");
    expect(text).toBe("Token (hidden): \n");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.listenerCount("data")).toBe(0);
  });
  it("cleans up a terminal on ctrl-C, abort and invalid input", async () => {
    for (const data of ["\u0003", "\r", "x".repeat(4097)]) {
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: true,
        setRawMode: vi.fn(),
      });
      const result = hiddenToken(
        input as unknown as ReadStream,
        new PassThrough(),
        signal(),
      );
      input.emit("data", Buffer.from(data));
      await expect(result).rejects.toThrow();
      expect(input.setRawMode).toHaveBeenLastCalledWith(true);
    }
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
    });
    const controller = new AbortController();
    const result = hiddenToken(
      input as unknown as ReadStream,
      new PassThrough(),
      controller.signal,
    );
    controller.abort(new CliError("TIMEOUT", "Timed out"));
    await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(input.listenerCount("data")).toBe(0);
  });
});
