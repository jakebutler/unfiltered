import { describe, it, expect, beforeEach } from "vitest";

// We test the registry logic in isolation by importing the module functions.
// Since the registry is module-level state, we need to be careful about test isolation.

describe("provider-registry", () => {
  // Use dynamic import to reset module state between tests
  it("registers and creates providers", async () => {
    const { registerProvider, createProvider, isProviderRegistered, getRegisteredProviders } =
      await import("@/lib/voice/provider-registry");

    const mockFactory = () => ({
      type: "speechmatics" as const,
      connect: async () => {},
      sendAudio: async () => {},
      receiveResponse: async function* () {},
      sendText: async () => {},
      disconnect: async () => {},
      calculateCost: () => 0,
      validateConfig: () => [],
    });

    registerProvider("speechmatics", mockFactory);

    expect(isProviderRegistered("speechmatics")).toBe(true);
    expect(getRegisteredProviders()).toContain("speechmatics");

    const provider = createProvider("speechmatics", {});
    expect(provider.type).toBe("speechmatics");
  });

  it("throws for unregistered provider", async () => {
    const { createProvider } = await import("@/lib/voice/provider-registry");

    expect(() => createProvider("nonexistent" as never, {})).toThrow(
      'Voice provider "nonexistent" is not registered'
    );
  });
});
