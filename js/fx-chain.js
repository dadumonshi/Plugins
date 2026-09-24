/**
 * fx-chain.js — реестр плагинов и последовательная FX-цепочка (insert-слоты).
 * fx-chain.js — plugin registry and serial FX chain (insert slots).
 *
 * Интерфейс плагина / Plugin interface:
 *   new Plugin(ctx, options) → { input: AudioNode, output: AudioNode,
 *     init(state?), getState(), setState(state), dispose(), model? }
 *   Plugin.descriptor = { id, name, category, description, editor }
 */

const registry = new Map();

export function registerPlugin(PluginClass) {
  const d = PluginClass.descriptor;
  if (!d || !d.id) throw new Error('Plugin descriptor with id required');
  registry.set(d.id, PluginClass);
}

/** Класс плагина по id (для офлайн-рендера) / plugin class by id (offline bounce). */
export function getPlugin(id) {
  return registry.get(id) || null;
}

export function listPlugins() {
  return [...registry.values()].map((P) => P.descriptor);
}

let slotCounter = 0;

/** Один insert-слот с собственным bypass / one insert slot with its own bypass. */
class Slot {
  constructor(ctx, PluginClass, options, state) {
    this.id = `fx${Date.now().toString(36)}${(slotCounter++).toString(36)}`;
    this.ctx = ctx;
    this.descriptor = PluginClass.descriptor;
    this.plugin = new PluginClass(ctx, options);
    this.plugin.init?.(state);
    this.name = this.descriptor.name;
    this.bypassed = false;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.dry.gain.value = 0;
    this.input.connect(this.plugin.input);
    this.plugin.output.connect(this.wet).connect(this.output);
    this.input.connect(this.dry).connect(this.output);
  }

  setBypass(on) {
    this.bypassed = on;
    const t = this.ctx.currentTime;
    this.wet.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
    this.dry.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
  }

  dispose() {
    this.plugin.dispose();
    for (const n of [this.input, this.output, this.wet, this.dry]) {
      try { n.disconnect(); } catch { /* noop */ }
    }
  }
}

export class FxChain extends EventTarget {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} input  — шина до FX / pre-FX bus
   * @param {AudioNode} output — шина после FX / post-FX bus
   */
  constructor(ctx, input, output, pluginOptions = {}) {
    super();
    this.ctx = ctx;
    this.inBus = input;
    this.outBus = output;
    this.slots = [];
    this.pluginOptions = pluginOptions;
    this._wire();
  }

  _emit() { this.dispatchEvent(new CustomEvent('change')); }

  _wire() {
    try { this.inBus.disconnect(); } catch { /* noop */ }
    this.slots.forEach((s) => { try { s.output.disconnect(); } catch { /* noop */ } });
    let prev = this.inBus;
    for (const s of this.slots) { prev.connect(s.input); prev = s.output; }
    prev.connect(this.outBus);
    // Внешние «отводы» (анализатор/запись) переподключаются владельцем.
    // External taps (meters/recording) are re-attached by the owner.
    this.dispatchEvent(new CustomEvent('rewire'));
  }

  add(pluginId, state, index = this.slots.length) {
    const P = registry.get(pluginId);
    if (!P) throw new Error(`Unknown plugin: ${pluginId}`);
    const slot = new Slot(this.ctx, P, this.pluginOptions, state);
    this.slots.splice(index, 0, slot);
    this._wire();
    this._emit();
    return slot;
  }

  remove(slotId) {
    const i = this.slots.findIndex((s) => s.id === slotId);
    if (i < 0) return;
    const [s] = this.slots.splice(i, 1);
    this._wire();
    s.dispose();
    this._emit();
  }

  move(slotId, dir) {
    const i = this.slots.findIndex((s) => s.id === slotId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.slots.length) return;
    [this.slots[i], this.slots[j]] = [this.slots[j], this.slots[i]];
    this._wire();
    this._emit();
  }

  setBypass(slotId, on) {
    const s = this.get(slotId);
    if (!s) return;
    s.setBypass(on);
    this._emit();
  }

  get(slotId) { return this.slots.find((s) => s.id === slotId) || null; }

  toJSON() {
    return this.slots.map((s) => ({ plugin: s.descriptor.id, bypass: s.bypassed, state: s.plugin.getState() }));
  }
}
