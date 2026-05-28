# slide-renderer

React component for rendering PPTist-style `Slide` JSON. Extracted from [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC).

> **v1 = 只读画布。** 编辑能力（选中、拖拽、resize、ProseMirror 内联编辑等）规划在 v2。

## Install

```bash
pnpm add slide-renderer
# or
npm install slide-renderer
```

Peer deps your project must provide:

- `react >= 18`
- `react-dom >= 18`
- `motion >= 11`
- `tailwindcss >= 4` （**包内组件使用 Tailwind 4 任意值类，消费者必须用 Tailwind 4**）

## Quickstart

```tsx
import { SlideCanvas, type Slide } from 'slide-renderer';

const slide: Slide = {
  id: 'demo-1',
  elements: [
    { type: 'text', id: 't1', left: 100, top: 80, width: 600, height: 60,
      content: '<p>Hello, Slide</p>', defaultFontName: 'sans-serif', defaultColor: '#222' },
  ],
  background: { type: 'solid', color: '#ffffff' },
};

export default function Demo() {
  return <SlideCanvas slide={slide} scale={1} />;
}
```

## API

详见 [DESIGN.md §3](./DESIGN.md#3-对外-api)。

### `<SlideCanvas slide effects? renderImage? renderVideo? onElementClick? scale? />`

只读渲染入口。所有数据走 props，零 store 依赖。

### `<SlideRendererProvider>` + `useSlideContext()`

可选高阶模式，便于自定义 overlay 子组件读取共享数据。

### `slide-renderer/elements`

细粒度复用：单独导出 9 个 `BaseXxxElement`（Text/Shape/Image/Line/Chart/Latex/Table/Video/Code）。

### `slide-renderer/types`

PPTist 风格的 `Slide` / `PPTElement` 等类型。

## Tailwind 4 配置

确保你的 `tailwind.config.{ts,js}` content 数组包含包源码：

```js
export default {
  content: [
    './src/**/*.{ts,tsx}',
    './node_modules/slide-renderer/dist/**/*.{js,cjs}',
  ],
}
```

## License

AGPL-3.0
