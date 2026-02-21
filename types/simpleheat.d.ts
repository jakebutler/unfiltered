declare module 'simpleheat' {
  interface SimpleHeat {
    data(data: [number, number, number][]): this;
    max(value: number): this;
    radius(r: number, blur?: number): this;
    draw(minOpacity?: number): this;
    resize(): void;
    clear(): void;
  }
  function simpleheat(canvas: HTMLCanvasElement): SimpleHeat;
  export = simpleheat;
}
