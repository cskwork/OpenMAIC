# SKILL

`pptxtojson-pro` 开发规范。请先读 `DESIGN.md` 了解架构。

## 修 bug 的标准流程

```bash
# 1. 解压 pptx 看源 XML
node scripts/extract-pptx-structure.js ./xxx.pptx ./out

# 2. 生成修改前的 JSON
npx tsx scripts/transvert.ts ./xxx.pptx ./before.json

# 3. 改代码

# 4. 生成修改后的 JSON，diff 对比
npx tsx scripts/transvert.ts ./xxx.pptx ./after.json
```

定位思路：JSON 数值错 → serializer；节点类型错 → model/Slide.ts；颜色错 → StyleResolver + color.ts；模板继承错 → RenderContext.ts。

## 代码规范

- **TypeScript strict**，不用 `@ts-ignore`，`any` 仅在必要时局部使用并加注释
- **注释解释"为什么"**，不解释"做了什么"
- **用已有工具**：单位用 `parser/units.ts`，XML 用 `SafeXmlNode`，颜色用 `utils/color.ts`
- commit message：中文，动词起头，点出修了什么
  - 好：`fix(text): 修复 solidFill/gradFill 互斥覆盖导致渐变遮盖文字颜色`
  - 坏：`fix bug` / `update`
- 一个 commit 只做一件事，重构和 bug 修复分开提

## 类型协议（重要）

`src/adapter/types.ts` 是与下游的 **协议**，修改需谨慎：

- **不改** 已有字段的名字或类型
- **不把** 可选字段改为必选
- **新增** 字段一律 `?:` 可选，附 JSDoc 说明
- 长度单位 pt，颜色 `#RRGGBB`，角度 deg

`model/*` 的内部类型可以自由重构，但保持"模型层不感知样式"原则。

## 分层红线

| 层 | 该做 | 不该做 |
|---|---|---|
| parser | 解压、XML 解析、单位换算 | 解析 OOXML 业务语义 |
| model | 解析几何与结构 | 解析视觉样式 |
| serializer | 模型 + 上下文 → JSON 元素 | 直接读 zip |
| adapter | 定义类型、组装输出 | 写业务逻辑 |
| shapes | 输出 SVG path | 决定填充/边框 |
| utils | 通用工具 | 引用业务类型 |

依赖方向：`adapter → serializer → model → parser`，**禁止反向**。

## 高风险文件

改这些文件前请格外注意：

**`groupSerializer.ts`** — chOff/chExt 缩放 + flip/rotation 烘焙。改前想清楚 `flipH+flipV → +180°` 等价规则。新增 child 特殊缩放规则时做 fast-path 短路。

**`shapeSerializer.ts`** — 800+ 行，承担 Shape/Text 判定、preset 路径、自适应等。调整 Shape vs Text 判定前，先用 `src1` 跑同样的 .pptx 对比。

**`presets.ts`** — 200+ preset 共享辅助函数，修一个前看调用方，避免误伤。

**`parser/units.ts`** — 被广泛依赖，**不要改现有函数签名**，需要新单位就加新函数。

## 注意事项

- `*.pptx`、`slides.json`、`out/`、`dist/` 已在 .gitignore 中，提交前 `git status` 确认不要带入
- `src1/` 是原版参考实现，**只读不改不构建**
- 改了 `adapter/types.ts` 需在 commit body 写明协议变更
