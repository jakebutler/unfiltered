import type { ProviderType, VoiceProvider } from "./types";

type ProviderFactory = (config: Record<string, unknown>) => VoiceProvider;

const registry = new Map<ProviderType, ProviderFactory>();

export function registerProvider(type: ProviderType, factory: ProviderFactory): void {
  registry.set(type, factory);
}

export function createProvider(type: ProviderType, config: Record<string, unknown>): VoiceProvider {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(`Voice provider "${type}" is not registered`);
  }
  return factory(config);
}

export function getRegisteredProviders(): ProviderType[] {
  return Array.from(registry.keys());
}

export function isProviderRegistered(type: ProviderType): boolean {
  return registry.has(type);
}
