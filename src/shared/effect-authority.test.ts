import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "./deferred.js";
import {
  prepareEffectAuthority,
  withEffectPreparation,
  type PreparedEffectUse,
} from "./effect-authority.js";

describe("prepared effect scope", () => {
  it("forwards remote native settlement to the original authority owner", async () => {
    const settled = createDeferredCore();
    const settlements: Array<Promise<unknown> | undefined> = [];
    const release = vi.fn();
    const use: PreparedEffectUse = {
      assertCurrent: () => {},
      initiate: (effect, settlement) => {
        settlements.push(settlement);
        return effect();
      },
      release,
      persist: (run) => run(() => {}),
    };
    await withEffectPreparation(
      async () => use,
      async () => {
        const prepared = await prepareEffectAuthority();
        expect(prepared?.initiate(() => "native launch", settled.promise)).toBe("native launch");
        expect(settlements).toEqual([settled.promise]);
        expect(release).not.toHaveBeenCalled();
        settled.resolve();
        await settled.promise;
        prepared?.release();
      },
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
