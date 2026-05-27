/* eslint-disable max-lines */
/* eslint-disable no-console */
import {
  parse as parsePptxDefault,
  type Shape,
  type Element,
  type ChartItem,
  type BaseElement
} from "pptxtojson";
import { nanoid } from "nanoid";
import katex from "katex";
import type {
  Slide,
  TableCellStyle,
  TableCell,
  ChartType,
  SlideBackground,
  PPTShapeElement,
  PPTLineElement,
  PPTImageElement,
  PPTLatexElement,
  ShapeTextAlign,
  PPTTextElement,
  ChartOptions,
  Gradient,
  ImageElementFilters
} from "../openmaic/types/slides";
import { SHAPE_PATH_FORMULAS } from "../openmaic/configs/shapes";
import { getSvgPathRange } from "../openmaic/utils/svgPathParser";
import { parseVideoCodec, isVideoCodecSupported } from "../openmaic/utils/videoCodec";
import { resolveFont } from "../openmaic/configs/font";
import type { FontReplacementBucket, ImportContext, TransformResult } from "./types";

type ParsedPptxJson = Awaited<ReturnType<typeof parsePptxDefault>>;

/**
 * 解析单个原字体名为可渲染的内部字体 value，并把"非白名单命中"的情况累计到 bucket。
 * 返回值始终是可直接写入元素 / HTML 的字体名（白名单命中时为 cleaned 原值）。
 */
const resolveAndRecord = (
  rawName: string | undefined | null,
  bucket: FontReplacementBucket
): string => {
  const r = resolveFont(rawName);
  if (r.original && r.source !== "whitelist") {
    const targetMap = r.source === "fallback" ? bucket.fallback : bucket.styled;
    if (!targetMap.has(r.original)) targetMap.set(r.original, r.resolved);
  }
  return r.resolved;
};

/** 把 HTML 中所有 font-family 声明替换为风格匹配后的开源字体 */
const replaceFontFamilyInHtml = (
  html: string,
  bucket: FontReplacementBucket
): string => {
  return html.replace(
    /font-family:\s*([^;"]+)/g,
    (_match, families: string) => `font-family: ${resolveAndRecord(families, bucket)}`
  );
};

const convertPtToPx = (html: string, ratio: number) => {
  return html.replace(/([\d.]+)pt\b/g, (_match, p1) => {
    return `${(parseFloat(p1) * ratio).toFixed(1)}px`;
  });
};

const createConcurrencyLimiter = (limit: number) => {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (!run) return;
    active += 1;
    run();
  };

  return <T>(task: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      };
      queue.push(run);
      next();
    });
  };
};

const rotateLine = (line: PPTLineElement, angleDeg: number) => {
  const { start, end } = line;

  const angleRad = (angleDeg * Math.PI) / 180;

  const midX = (start[0] + end[0]) / 2;
  const midY = (start[1] + end[1]) / 2;

  const startTransX = start[0] - midX;
  const startTransY = start[1] - midY;
  const endTransX = end[0] - midX;
  const endTransY = end[1] - midY;

  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  const startRotX = startTransX * cosA - startTransY * sinA;
  const startRotY = startTransX * sinA + startTransY * cosA;

  const endRotX = endTransX * cosA - endTransY * sinA;
  const endRotY = endTransX * sinA + endTransY * cosA;

  const startNewX = startRotX + midX;
  const startNewY = startRotY + midY;
  const endNewX = endRotX + midX;
  const endNewY = endRotY + midY;

  const beforeMinX = Math.min(start[0], end[0]);
  const beforeMinY = Math.min(start[1], end[1]);

  const afterMinX = Math.min(startNewX, endNewX);
  const afterMinY = Math.min(startNewY, endNewY);

  const startAdjustedX = startNewX - afterMinX;
  const startAdjustedY = startNewY - afterMinY;
  const endAdjustedX = endNewX - afterMinX;
  const endAdjustedY = endNewY - afterMinY;

  const startAdjusted: [number, number] = [startAdjustedX, startAdjustedY];
  const endAdjusted: [number, number] = [endAdjustedX, endAdjustedY];
  const offset = [afterMinX - beforeMinX, afterMinY - beforeMinY];

  return {
    start: startAdjusted,
    end: endAdjusted,
    offset
  };
};

/**
 * 从 SVG path 中提取两段 C 命令的控制点，近似为 PPTist 单段三次贝塞尔。
 * path 中数值与 JSON 的 width/height 同为 pt；parseLineElement 里 start/end 已乘 ratio，
 * 控制点也必须乘 ratio，否则与端点量纲不一致，曲线会退化为近似直线。
 */
const parseCubicFromPath = (
  path: string,
  w: number,
  h: number,
  flipH: boolean,
  flipV: boolean,
  ratio: number
): [[number, number], [number, number]] | null => {
  const cSegments = [...path.matchAll(/[Cc]([\d.,\s-]+)/g)];
  if (cSegments.length === 0) return null;

  const parseNums = (s: string) => s.trim().split(/[\s,]+/).map(Number);

  const firstNums = parseNums(cSegments[0][1]);
  const lastNums = parseNums(cSegments[cSegments.length - 1][1]);

  if (firstNums.length < 2 || lastNums.length < 6) return null;

  let cp1: [number, number] = [firstNums[0] * ratio, firstNums[1] * ratio];
  let cp2: [number, number] = [lastNums[2] * ratio, lastNums[3] * ratio];

  if (flipH) {
    cp1[0] = w - cp1[0];
    cp2[0] = w - cp2[0];
  }
  if (flipV) {
    cp1[1] = h - cp1[1];
    cp2[1] = h - cp2[1];
  }

  return [cp1, cp2];
};

/**
 * 从 pptxtojson-pro 的 line path 中检测箭头三角形。
 *
 * path 结构：主线段 `M<x1>,<y1> L<x2>,<y2>` 后，每个箭头追加一段
 * 闭合三角形 `M<base>L<p1>L<p2>Z`，其中 base 与主线段的某个端点重合。
 * 返回 [headArrow, tailArrow]，head = 线段起点方向，tail = 线段终点方向。
 */
const detectArrowsFromPath = (path: string): [boolean, boolean] => {
  const segments = path.split(/(?=M)/g).filter(Boolean);
  if (segments.length < 2) return [false, false];

  // 主路径起点：第一个 M 后的两个数字
  const startMatch = segments[0].match(
    /M\s*([\d.eE+-]+)\s*[,\s]\s*([\d.eE+-]+)/
  );
  if (!startMatch) return [false, false];

  // 主路径终点：取主 segment 中的所有数字，最后一对就是终点。
  // 这样可同时兼容 L (直线 connector)、C (curvedConnector，cubic bezier)、
  // Q / A 等任意 SVG 路径命令。原实现强制要求 L，curved connector 的
  // M..C.. 主路径直接 mainMatch 失败返回 [false, false]，导致即便 OOXML
  // 显式 type="arrow" 的 curved connector 也丢箭头。
  const allNums = segments[0].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!allNums || allNums.length < 4) return [false, false];

  const sx = Number(startMatch[1]), sy = Number(startMatch[2]);
  const ex = Number(allNums[allNums.length - 2]);
  const ey = Number(allNums[allNums.length - 1]);

  let head = false, tail = false;
  for (let i = 1; i < segments.length; i++) {
    // pptxtojson-pro 的 arrow 子路径有两种格式：
    //   - triangle / diamond / oval (含默认 stealth)：M..L..L..[L..]Z
    //   - openArrow (OOXML type="arrow")：           M..L..L..  ← 无 Z
    // 原实现强制要求 Z，会漏掉 openArrow 类型。放宽为「含 Z」或「至少
    // 2 个 L」即视为 arrow（普通主路径不会有 ≥2 个 L）。
    const seg = segments[i];
    const hasZ = seg.includes("Z");
    const lCount = (seg.match(/L/g) || []).length;
    if (!hasZ && lCount < 2) continue;
    const m = seg.match(/M\s*([\d.eE+-]+)\s*[,\s]\s*([\d.eE+-]+)/);
    if (!m) continue;
    const ax = Number(m[1]), ay = Number(m[2]);
    const distHead = Math.hypot(ax - sx, ay - sy);
    const distTail = Math.hypot(ax - ex, ay - ey);
    if (distHead <= distTail) head = true;
    else tail = true;
  }
  return [head, tail];
};

const parseLineElement = (el: Shape, ratio: number) => {
  let start: [number, number] = [0, 0];
  let end: [number, number] = [0, 0];

  if (!el.isFlipV && !el.isFlipH) {
    // 右下
    start = [0, 0];
    end = [el.width, el.height];
  } else if (el.isFlipV && el.isFlipH) {
    // 左上
    start = [el.width, el.height];
    end = [0, 0];
  } else if (el.isFlipV && !el.isFlipH) {
    // 右上
    start = [0, el.height];
    end = [el.width, 0];
  } else {
    // 左下
    start = [el.width, 0];
    end = [0, el.height];
  }

  const [headArrow, tailArrow] = (el as any).path
    ? detectArrowsFromPath((el as any).path)
    : [false, false];

  // 不再用 "isConnector ? arrow : empty" 作为 tail 的兜底：OOXML preset
  // connector (straightConnector/curvedConnector) 默认就是无箭头的，
  // 是否有箭头完全取决于 a:headEnd/tailEnd 的 type。pptxtojson-pro 已按
  // OOXML 把 arrow 几何 append 到 path（或不 append），detectArrowsFromPath
  // 是唯一权威信号。原 fallback 会给所有 connector 强加箭头，破坏那些
  // 显式 type="none" 的 case（典型：FP-tree 节点之间的实线连接）。

  const data: PPTLineElement = {
    type: "line",
    id: nanoid(10),
    width: +((el.borderWidth || 1) * ratio).toFixed(2),
    left: el.left,
    top: el.top,
    start,
    end,
    style: el.borderType,
    color: el.borderColor,
    points: [
      headArrow ? "arrow" : "",
      tailArrow ? "arrow" : ""
    ]
  };
  if (el.rotate) {
    const { start, end, offset } = rotateLine(data, el.rotate);

    data.start = start;
    data.end = end;
    data.left = data.left + offset[0];
    data.top = data.top + offset[1];
  }
  if (/bentConnector/.test(el.shapType)) {
    data.broken2 = [
      Math.abs(data.start[0] - data.end[0]) / 2,
      Math.abs(data.start[1] - data.end[1]) / 2
    ];
  }
  if (/curvedConnector/.test(el.shapType)) {
    let cubicResolved = false;
    if ((el as any).path) {
      const cubic = parseCubicFromPath(
        (el as any).path,
        el.width,
        el.height,
        !!el.isFlipH,
        !!el.isFlipV,
        ratio
      );
      if (cubic) {
        data.cubic = cubic;
        cubicResolved = true;
      }
    }
    if (!cubicResolved) {
      const cubic: [number, number] = [
        Math.abs(data.start[0] - data.end[0]) / 2,
        Math.abs(data.start[1] - data.end[1]) / 2
      ];
      data.cubic = [cubic, cubic];
    }
  }

  return data;
};

const flipGroupElements = (elements: BaseElement[], axis: "x" | "y") => {
  const minX = Math.min(...elements.map(el => el.left));
  const maxX = Math.max(...elements.map(el => el.left + el.width));
  const minY = Math.min(...elements.map(el => el.top));
  const maxY = Math.max(...elements.map(el => el.top + el.height));

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return elements.map(element => {
    const newElement = { ...element };

    if (axis === "y") newElement.left = 2 * centerX - element.left - element.width;
    if (axis === "x") newElement.top = 2 * centerY - element.top - element.height;

    return newElement;
  });
};

const calculateRotatedPosition = (
  x: number,
  y: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
  k: number
) => {
  const radians = k * (Math.PI / 180);

  const containerCenterX = x + w / 2;
  const containerCenterY = y + h / 2;

  const relativeX = ox - w / 2;
  const relativeY = oy - h / 2;

  const rotatedX = relativeX * Math.cos(radians) + relativeY * Math.sin(radians);
  const rotatedY = -relativeX * Math.sin(radians) + relativeY * Math.cos(radians);

  const graphicX = containerCenterX + rotatedX;
  const graphicY = containerCenterY + rotatedY;

  return { x: graphicX, y: graphicY };
};

// 文本元素安全放大系数，用来吸收字体回退后字形宽度的细微差异（1.05 ~ 1.2 都可）
// 当字体白名单覆盖到 PingFang / 微软雅黑 等常见中文字体后，可以考虑去掉
const SAFE_PADDING = 1.1;

export async function transformParsedToSlides(
  json: ParsedPptxJson,
  ctx: ImportContext
): Promise<TransformResult> {
  const ratio = ctx.ratio;
  const theme = ctx.theme;
  const shapeList = ctx.shapeList;
  const replacedFonts = ctx.replacedFonts;
  const viewportWidth = ctx.viewportWidth;
  const sizeRatio = json.size.height / json.size.width;
  const viewportHeight = viewportWidth * sizeRatio;

  const slides: Slide[] = [];
  // base64 图片上传改为并发
  const limitUpload = createConcurrencyLimiter(6);
  const uploadTasks: Promise<unknown>[] = [];
  for (const item of json.slides) {
    const { type, value } = item.fill;
    let background: SlideBackground;
    if (type === "image") {
      // 背景图片：先用 base64，占位并发上传，成功后回填 URL
      background = {
        type: "image",
        image: {
          src: value.picBase64,
          size: "cover"
        }
      };
      if (value.picBase64 && value.picBase64.startsWith("data:")) {
        const bg = background.image!;
        uploadTasks.push(
          limitUpload(() =>
            ctx.uploadBase64Image(
              value.picBase64,
              `background_${Date.now()}.png`,
              "a2m"
            )
          )
            .then(url => {
              bg.src = url;
            })
            .catch(error => {
              console.error("背景图片上传失败:", error);
            })
        );
      }
    } else if (type === "gradient") {
      background = {
        type: "gradient",
        gradient: {
          type: value.path === "line" ? "linear" : "radial",
          colors: value.colors.map(item => ({
            ...item,
            pos: parseInt(item.pos)
          })),
          rotate: value.rot + 90
        }
      };
    } else {
      background = {
        type: "solid",
        color: (value as string) || "#fff"
      };
    }

    const slide: Slide = {
      id: nanoid(10),
      elements: [],
      background,
      script: item.note || ""
    };

    const parseElements = async (elements: Element[]) => {
      const sortedElements = elements.sort((a, b) => a.order - b.order);

      for (const el of sortedElements) {
        const originWidth = el.width || 1;
        const originHeight = el.height || 1;
        const originLeft = el.left;
        const originTop = el.top;

        el.width = el.width * ratio;
        el.height = el.height * ratio;
        el.left = el.left * ratio;
        el.top = el.top * ratio;
        if (el.type === "text") {
          const vAlignMap: { [key: string]: ShapeTextAlign } = {
            mid: "middle",
            down: "bottom",
            up: "top"
          };

          // autoFit.type === 'text'：文字缩小适应容器，容器尺寸固定
          // 转为 shape 元素，使填充色严格覆盖 width × height 区域
          if ((el as any).autoFit && (el as any).autoFit.type === "text") {
            const fontScale = ratio * ((el as any).autoFit.fontScale || 100) / 100;
            const gradient: Gradient | undefined =
              el.fill?.type === "gradient"
                ? {
                    type: el.fill.value.path === "line" ? "linear" : "radial",
                    colors: el.fill.value.colors.map(item => ({
                      ...item,
                      pos: parseInt(item.pos)
                    })),
                    rotate: el.fill.value.rot
                  }
                : undefined;
            const shapeEl: PPTShapeElement = {
              type: "shape",
              id: nanoid(10),
              width: el.width,
              height: el.height,
              left: el.left,
              top: el.top,
              rotate: el.rotate,
              viewBox: [200, 200],
              path: "M 0 0 L 200 0 L 200 200 L 0 200 Z",
              fill: el.fill?.type === "color" ? el.fill.value : "",
              gradient,
              fixedRatio: false,
              text: {
                content: replaceFontFamilyInHtml(convertPtToPx(el.content, fontScale), replacedFonts),
                defaultFontName: theme.fontName,
                defaultColor: theme.fontColor,
                align: vAlignMap[el.vAlign] || "middle"
              }
            };
            // 只有当 borderWidth 存在且大于 0 时才设置 outline
            if (el.borderWidth && el.borderWidth > 0) {
              shapeEl.outline = {
                color: el.borderColor,
                width: +(el.borderWidth * ratio).toFixed(2),
                style: el.borderType
              };
            }
            if (el.shadow) {
              shapeEl.shadow = {
                h: el.shadow.h * ratio,
                v: el.shadow.v * ratio,
                blur: el.shadow.blur * ratio,
                color: el.shadow.color
              };
            }
            slide.elements.push(shapeEl);
          } else if (el.fill?.type === "gradient" || el.fill?.type === "image") {
            // gradient / image fill 不被 PPTTextElement 支持，转为 shape 元素
            const gradient: Gradient | undefined =
              el.fill.type === "gradient"
                ? {
                    type: el.fill.value.path === "line" ? "linear" : "radial",
                    colors: el.fill.value.colors.map(item => ({
                      ...item,
                      pos: parseInt(item.pos)
                    })),
                    rotate: el.fill.value.rot
                  }
                : undefined;
            let pattern: string | undefined;
            if (el.fill.type === "image") {
              pattern = el.fill.value.picBase64;
            }
            const shapeEl: PPTShapeElement = {
              type: "shape",
              id: nanoid(10),
              width: el.width,
              height: el.height,
              left: el.left,
              top: el.top,
              rotate: el.rotate,
              viewBox: [200, 200],
              path: "M 0 0 L 200 0 L 200 200 L 0 200 Z",
              fill: "",
              gradient,
              pattern,
              fixedRatio: false,
              text: {
                content: replaceFontFamilyInHtml(convertPtToPx(el.content, ratio), replacedFonts),
                defaultFontName: theme.fontName,
                defaultColor: theme.fontColor,
                align: vAlignMap[el.vAlign] || "middle"
              }
            };
            if (el.borderWidth && el.borderWidth > 0) {
              shapeEl.outline = {
                color: el.borderColor,
                width: +(el.borderWidth * ratio).toFixed(2),
                style: el.borderType
              };
            }
            if (el.shadow) {
              shapeEl.shadow = {
                h: el.shadow.h * ratio,
                v: el.shadow.v * ratio,
                blur: el.shadow.blur * ratio,
                color: el.shadow.color
              };
            }
            slide.elements.push(shapeEl);
          } else {
            // 普通文本元素：仅应用安全放大系数吸收字体差异，padding 已在渲染器侧移除，无需再补偿
            el.width = Math.min(el.width * SAFE_PADDING, viewportWidth - el.left);
            el.height = Math.min(el.height * SAFE_PADDING, viewportHeight - el.top);

            const textEl: PPTTextElement = {
              type: "text",
              id: nanoid(10),
              width: el.width,
              height: el.height,
              left: el.left,
              top: el.top,
              rotate: el.rotate,
              defaultFontName: theme.fontName,
              defaultColor: theme.fontColor,
              content: replaceFontFamilyInHtml(convertPtToPx(el.content, ratio), replacedFonts),
              lineHeight: 1,
              fill: el.fill?.type === "color" ? el.fill.value : "",
              vertical: el.isVertical
            };
            if (el.borderWidth && el.borderWidth > 0) {
              textEl.outline = {
                color: el.borderColor,
                width: +(el.borderWidth * ratio).toFixed(2),
                style: el.borderType
              };
            }
            if (el.shadow) {
              textEl.shadow = {
                h: el.shadow.h * ratio,
                v: el.shadow.v * ratio,
                blur: el.shadow.blur * ratio,
                color: el.shadow.color
              };
            }
            slide.elements.push(textEl);
          }
        } else if (el.type === "image") {
          const imageSrc = el.src;

          const element: PPTImageElement = {
            type: "image",
            id: nanoid(10),
            src: imageSrc,
            width: el.width,
            height: el.height,
            left: el.left,
            top: el.top,
            fixedRatio: true,
            rotate: el.rotate,
            flipH: el.isFlipH,
            flipV: el.isFlipV
          };
          const rawFilters = (el as any).filters as
            | { brightness?: number; contrast?: number; saturation?: number }
            | undefined;
          if (rawFilters) {
            const cssFilters: ImageElementFilters = {};
            if (rawFilters.brightness != null) cssFilters.brightness = `${(1 + rawFilters.brightness).toFixed(2)}`;
            if (rawFilters.contrast != null) cssFilters.contrast = `${(1 + rawFilters.contrast).toFixed(2)}`;
            if (rawFilters.saturation != null) cssFilters.saturate = `${(1 + rawFilters.saturation).toFixed(2)}`;
            if (Object.keys(cssFilters).length) element.filters = cssFilters;
          }
          if (el.borderWidth) {
            element.outline = {
              color: el.borderColor,
              width: +(el.borderWidth * ratio).toFixed(2),
              style: el.borderType
            };
          }
          const clipShapeTypes = [
            "roundRect",
            "ellipse",
            "triangle",
            "rhombus",
            "pentagon",
            "hexagon",
            "heptagon",
            "octagon",
            "parallelogram",
            "trapezoid"
          ];
          if (el.rect) {
            element.clip = {
              shape: el.geom && clipShapeTypes.includes(el.geom) ? el.geom : "rect",
              range: [
                [el.rect.l || 0, el.rect.t || 0],
                [100 - (el.rect.r || 0), 100 - (el.rect.b || 0)]
              ]
            };
          } else if (el.geom && clipShapeTypes.includes(el.geom)) {
            element.clip = {
              shape: el.geom,
              range: [
                [0, 0],
                [100, 100]
              ]
            };
          }
          slide.elements.push(element);
          // 如果是 base64 图片：并发上传，成功后回填 URL
          if (el.src && el.src.startsWith("data:")) {
            uploadTasks.push(
              limitUpload(() =>
                ctx.uploadBase64Image(
                  el.src,
                  `image_${Date.now()}.png`,
                  "a2m"
                )
              )
                .then(url => {
                  element.src = url;
                })
                .catch(error => {
                  console.error("图片元素上传失败:", error);
                })
            );
          }
        } else if (el.type === "math") {
          let usedKatex = false;
          if (el.latex) {
            try {
              katex.renderToString(el.latex, { throwOnError: true, displayMode: true });
              const latexElement: PPTLatexElement = {
                type: "latex",
                id: nanoid(10),
                latex: el.latex,
                path: "",
                color: "#000000",
                strokeWidth: 2,
                viewBox: [el.width, el.height],
                width: el.width,
                height: el.height,
                left: el.left,
                top: el.top,
                fixedRatio: true,
                rotate: 0
              };
              slide.elements.push(latexElement);
              usedKatex = true;
            } catch (error) {
              console.warn("[PPTX导入] KaTeX 无法渲染公式，回退为图片:", error);
            }
          }
          if (!usedKatex) {
            const mathElement: PPTImageElement = {
              type: "image",
              id: nanoid(10),
              src: el.picBase64,
              width: el.width,
              height: el.height,
              left: el.left,
              top: el.top,
              fixedRatio: true,
              rotate: 0
            };
            slide.elements.push(mathElement);
            if (el.picBase64 && el.picBase64.startsWith("data:")) {
              uploadTasks.push(
                limitUpload(() =>
                  ctx.uploadBase64Image(
                    el.picBase64,
                    `math_${Date.now()}.png`,
                    "a2m"
                  )
                )
                  .then(url => {
                    mathElement.src = url;
                  })
                  .catch(error => {
                    console.error("数学公式图片上传失败:", error);
                  })
              );
            }
          }
        } else if (el.type === "audio") {
          console.log("🔍 音频元素完整信息:", JSON.stringify(el, null, 2));
          const audioElement: any = {
            type: "audio" as const,
            id: nanoid(10),
            src: el.blob || "",
            width: el.width,
            height: el.height,
            left: el.left,
            top: el.top,
            rotate: 0,
            fixedRatio: false,
            color: theme.themeColors[0],
            loop: false,
            autoplay: false
          };
          slide.elements.push(audioElement);

          // 上传到 OSS
          if (el.blob && el.blob.startsWith("blob:")) {
            uploadTasks.push(
              limitUpload(async () => {
                const response = await fetch(el.blob!);
                const blob = await response.blob();
                return ctx.uploadBlobMedia(
                  blob,
                  `audio_${Date.now()}.mp3`,
                  "a2m/audio"
                );
              })
                .then(url => {
                  audioElement.src = url;
                  audioElement.ext = "mp3";
                })
                .catch(error => {
                  console.error("❌ 音频上传失败:", error);
                })
            );
          } else if (!el.blob || el.blob === "") {
            console.warn("⚠️ 音频 blob 为空，将显示损坏音频图标");
          } else {
            console.warn("⚠️ 音频 blob 不是有效的 blob URL，实际值:", el.blob);
          }
        } else if (el.type === "video") {
          const videoElement: any = {
            type: "video" as const,
            id: nanoid(10),
            src: el.blob || "",
            width: el.width,
            height: el.height,
            left: el.left,
            top: el.top,
            rotate: 0,
            autoplay: false,
            poster: el.src || ""
          };
          slide.elements.push(videoElement);

          // 上传到 OSS
          if (el.blob && el.blob.startsWith("blob:")) {
            uploadTasks.push(
              limitUpload(async () => {
                try {
                  const blobResp = await fetch(el.blob!);
                  const arrayBuffer = await blobResp.arrayBuffer();
                  const codecInfo = await parseVideoCodec(arrayBuffer);
                  console.log("[PPTX导入] 视频编码解析结果:", codecInfo);

                  if (!isVideoCodecSupported(codecInfo)) {
                    console.warn("[PPTX导入] 视频编码不支持:", codecInfo?.videoCodec);
                    const iconSize = 120;
                    const origW = videoElement.width;
                    const origH = videoElement.height;
                    videoElement.codecError = true;
                    videoElement.src = "";
                    videoElement.width = iconSize;
                    videoElement.height = iconSize;
                    videoElement.left = videoElement.left + (origW - iconSize) / 2;
                    videoElement.top = videoElement.top + (origH - iconSize) / 2;
                    return null;
                  }
                } catch (err) {
                  console.warn("[PPTX导入] 视频编码解析失败:", err);
                }
                const response = await fetch(el.blob!);
                const blob = await response.blob();
                return ctx.uploadBlobMedia(
                  blob,
                  `video_${Date.now()}.mp4`,
                  "a2m/video"
                );
              })
                .then(result => {
                  if (result) {
                    videoElement.src = result;
                    videoElement.ext = "mp4";
                  }
                })
                .catch(error => {
                  console.error("视频上传失败:", error);
                })
            );
          }
        } else if (el.type === "shape") {
          if (el.shapType === "line" || /Connector/.test(el.shapType)) {
            const lineElement = parseLineElement(el, ratio);
            slide.elements.push(lineElement);
          } else {
            const shape = shapeList.find(
              item => item.pptxShapeType === el.shapType
            );

            const vAlignMap: { [key: string]: ShapeTextAlign } = {
              mid: "middle",
              down: "bottom",
              up: "top"
            };

            const gradient: Gradient | undefined =
              el.fill?.type === "gradient"
                ? {
                    type: el.fill.value.path === "line" ? "linear" : "radial",
                    colors: el.fill.value.colors.map(item => ({
                      ...item,
                      pos: parseInt(item.pos)
                    })),
                    rotate: el.fill.value.rot
                  }
                : undefined;

            let pattern: string | undefined = undefined;
            let opacity: number = 1;
            if (el.fill?.type === "image") {
              pattern = el.fill.value.picBase64;
              opacity = el.fill.value.opacity;
            }
            const fill = el.fill?.type === "color" ? el.fill.value : "";

            const element: PPTShapeElement = {
              type: "shape",
              id: nanoid(10),
              width: el.width,
              height: el.height,
              left: el.left,
              top: el.top,
              viewBox: [200, 200],
              path: "M 0 0 L 200 0 L 200 200 L 0 200 Z",
              fill,
              gradient,
              pattern,
              opacity: opacity,
              fixedRatio: false,
              rotate: el.rotate,
              text: {
                content: replaceFontFamilyInHtml(convertPtToPx(el.content, ratio), replacedFonts),
                defaultFontName: theme.fontName,
                defaultColor: theme.fontColor,
                align: vAlignMap[el.vAlign] || "middle"
              },
              flipH: el.isFlipH,
              flipV: el.isFlipV
            };
            // 只有当 borderWidth 存在且大于 0 时才设置 outline
            if (el.borderWidth && el.borderWidth > 0) {
              element.outline = {
                color: el.borderColor,
                width: +(el.borderWidth * ratio).toFixed(2),
                style: el.borderType
              };
            }
            if (el.shadow) {
              element.shadow = {
                h: el.shadow.h * ratio,
                v: el.shadow.v * ratio,
                blur: el.shadow.blur * ratio,
                color: el.shadow.color
              };
            }

            if (shape) {
              element.path = shape.path;
              element.viewBox = shape.viewBox;

              if (shape.pathFormula) {
                element.pathFormula = shape.pathFormula;
                element.viewBox = [el.width, el.height];

                const pathFormula = SHAPE_PATH_FORMULAS[shape.pathFormula];
                if ("editable" in pathFormula && pathFormula.editable) {
                  element.path = pathFormula.formula(
                    el.width,
                    el.height,
                    pathFormula.defaultValue
                  );
                  element.keypoints = pathFormula.defaultValue;
                } else element.path = pathFormula.formula(el.width, el.height);
              }
            } else if (el.path && el.path.indexOf("NaN") === -1) {
              element.path = el.path;
              element.viewBox = [originWidth, originHeight];
            }
            if (el.shapType === "custom") {
              if (el.path!.indexOf("NaN") !== -1) {
                if (element.width === 0) element.width = 0.1;
                if (element.height === 0) element.height = 0.1;
                element.path = el.path!.replace(/NaN/g, "0");
              } else {
                element.special = true;
                element.path = el.path!;
              }
              const { maxX, maxY } = getSvgPathRange(element.path);
              element.viewBox = [maxX || originWidth, maxY || originHeight];
            }

            if (element.path) {
              slide.elements.push(element);
              // 形状填充图片：并发上传，成功后回填 URL
              if (pattern && pattern.startsWith("data:")) {
                // TS 窄化：避免将 `let pattern: string | undefined` 捕获进异步闭包导致类型回退
                const patternBase64 = pattern;
                uploadTasks.push(
                  limitUpload(() =>
                    ctx.uploadBase64Image(
                      patternBase64,
                      `pattern_${Date.now()}.png`,
                      "a2m"
                    )
                  )
                    .then(url => {
                      element.pattern = url;
                    })
                    .catch(error => {
                      console.error("形状填充图片上传失败:", error);
                    })
                );
              }
            }
          }
        } else if (el.type === "table") {
          const row = el.data.length;
          const col = el.data[0].length;

          const style: TableCellStyle = {
            fontname: theme.fontName,
            color: theme.fontColor
          };
          const data: TableCell[][] = [];
          for (let i = 0; i < row; i++) {
            const rowCells: TableCell[] = [];
            for (let j = 0; j < col; j++) {
              const cellData = el.data[i][j];

              let textDiv: HTMLDivElement | null = document.createElement("div");
              textDiv.innerHTML = cellData.text;
              const ps = Array.from(textDiv.querySelectorAll("p"));
              const align = ps[0]?.style.textAlign || "left";
              // 单元格 padding 从外层 <div style="padding: ..."> 上提取（pptxtojson 把 PPT 的 cell margin 写在这里）
              // 不能跟 text 一起留在 HTML 里，否则 formatText 的 &nbsp; 替换会破坏 style 属性
              const padding = (
                (textDiv.firstElementChild as HTMLElement | null)?.style
                  ?.padding || ""
              ).trim();

              const span = textDiv.querySelector("span");
              const fontsize = span?.style.fontSize
                ? (parseInt(span?.style.fontSize) * ratio).toFixed(1) + "px"
                : "";
              const fontname = resolveAndRecord(span?.style.fontFamily, replacedFonts);
              const color = span?.style.color || cellData.fontColor;

              // 保留原始 <p> 段落结构（PPT 一个 <p> = 一段）
              // 段内 <span> 的内联样式不保留：cell.style 已统一收口尺寸/颜色/字体，避免 inline 样式（pt 单位）覆盖按 ratio 折算后的 px 值
              // 段内 <br> 经 innerText 转成 \n，下游 formatText 再转回换行
              const escapeHtml = (s: string) =>
                s
                  .replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;");
              const text =
                ps.length > 0
                  ? ps.map(p => `<p>${escapeHtml(p.innerText)}</p>`).join("")
                  : textDiv.innerText;

              rowCells.push({
                id: nanoid(10),
                colspan: cellData.colSpan || 1,
                rowspan: cellData.rowSpan || 1,
                text,
                // ParsedPptxJson 类型走的是官方 pptxtojson（其 TableCell 没有 vAlign），
                // 但运行时由 pptxtojson-pro 输出该字段（adapter/types.d.ts 已声明），故走断言。
                // 统一类型源即可消除此断言，属于本 PR 范围外的清理。
                vAlign: (cellData as { vAlign?: "up" | "mid" | "down" })
                  .vAlign,
                padding: padding || undefined,
                style: {
                  ...style,
                  align: ["left", "right", "center"].includes(align)
                    ? (align as "left" | "right" | "center")
                    : "left",
                  fontsize,
                  fontname,
                  color,
                  bold: cellData.fontBold,
                  backcolor: cellData.fillColor
                }
              });
              textDiv = null;
            }
            data.push(rowCells);
          }

          const allWidth = el.colWidths.reduce((a, b) => a + b, 0);
          const colWidths: number[] = el.colWidths.map(item => item / allWidth);

          const firstCell = el.data[0][0];
          const border =
            firstCell.borders.top ||
            firstCell.borders.bottom ||
            el.borders.top ||
            el.borders.bottom ||
            firstCell.borders.left ||
            firstCell.borders.right ||
            el.borders.left ||
            el.borders.right;
          const borderWidth = border?.borderWidth || 0;
          const borderStyle = border?.borderType || "solid";
          const borderColor = border?.borderColor || "#eeece1";

          // rowHeights（pt → px）：
          // - 全 0：解析库在 PPT 自动行高场景下可能返回全 0，用 element.height 均分兜底
          // - 其余：直接 pt × ratio；PPT XML 里 <a:tr h> 可能是"标称值"导致 sum(rowHeights) ≠ element.height，
          //   归一化策略的取舍记录在 docs/plans/a2m-table-import-render.md
          const rowCount = data.length;
          const rawRowHeightsPt = el.rowHeights ?? [];
          const sumRawPt = rawRowHeightsPt.reduce((a, b) => a + b, 0);
          let rowHeightsPx: number[] | undefined;
          if (rowCount > 0) {
            if (sumRawPt <= 0) {
              rowHeightsPx = new Array(rowCount).fill(el.height / rowCount);
            } else {
              rowHeightsPx = rawRowHeightsPt.map(h => h * ratio);
            }
          }
          slide.elements.push({
            type: "table",
            id: nanoid(10),
            width: el.width,
            height: el.height,
            left: el.left,
            top: el.top,
            colWidths,
            rotate: 0,
            data,
            outline: {
              width: +(borderWidth * ratio || 2).toFixed(2),
              style: borderStyle,
              color: borderColor
            },
            cellMinHeight: rowHeightsPx?.[0] || 36,
            rowHeights: rowHeightsPx
          });
        } else if (el.type === "chart") {
          let labels: string[];
          let legends: string[];
          let series: number[][];

          if (el.chartType === "scatterChart" || el.chartType === "bubbleChart") {
            labels = el.data[0].map((item, index) => `坐标${index + 1}`);
            legends = ["X", "Y"];
            series = el.data;
          } else {
            const data = el.data as ChartItem[];
            labels = Object.values(data[0].xlabels);
            legends = data.map(item => item.key);
            series = data.map(item => item.values.map(v => v.y));
          }

          const options: ChartOptions = {};

          let chartType: ChartType = "bar";

          switch (el.chartType) {
            case "barChart":
            case "bar3DChart":
              chartType = "bar";
              if (el.barDir === "bar") chartType = "column";
              if (el.grouping === "stacked" || el.grouping === "percentStacked") {
                options.stack = true;
              }
              break;
            case "lineChart":
            case "line3DChart":
              if (el.grouping === "stacked" || el.grouping === "percentStacked") {
                options.stack = true;
              }
              chartType = "line";
              break;
            case "areaChart":
            case "area3DChart":
              if (el.grouping === "stacked" || el.grouping === "percentStacked") {
                options.stack = true;
              }
              chartType = "area";
              break;
            case "scatterChart":
            case "bubbleChart":
              chartType = "scatter";
              break;
            case "pieChart":
            case "pie3DChart":
              chartType = "pie";
              break;
            case "radarChart":
              chartType = "radar";
              break;
            case "doughnutChart":
              chartType = "ring";
              break;
            default:
          }

          slide.elements.push({
            type: "chart",
            id: nanoid(10),
            chartType: chartType,
            width: el.width,
            height: el.height,
            left: el.left,
            top: el.top,
            rotate: 0,
            themeColors: el.colors.length ? el.colors : theme.themeColors,
            textColor: theme.fontColor,
            data: {
              labels,
              legends,
              series
            },
            options
          });
        } else if (el.type === "group") {
          let elements: BaseElement[] = el.elements.map(_el => {
            let left = _el.left + originLeft;
            let top = _el.top + originTop;

            if (el.rotate) {
              const { x, y } = calculateRotatedPosition(
                originLeft,
                originTop,
                originWidth,
                originHeight,
                _el.left,
                _el.top,
                el.rotate
              );
              left = x;
              top = y;
            }

            const element = {
              ..._el,
              left,
              top
            };
            if (el.isFlipH && "isFlipH" in element) element.isFlipH = true;
            if (el.isFlipV && "isFlipV" in element) element.isFlipV = true;

            return element;
          });
          if (el.isFlipH) elements = flipGroupElements(elements, "y");
          if (el.isFlipV) elements = flipGroupElements(elements, "x");
          await parseElements(elements);
        } else if (el.type === "diagram") {
          const elements = el.elements.map(_el => ({
            ..._el,
            left: _el.left + originLeft,
            top: _el.top + originTop
          }));
          await parseElements(elements);
        }
      }
    };
    // layoutElements 先渲染（z-index 小），slide elements 后渲染（z-index 大）
    // 与 PPTX 分层规则一致：slide 层永远在 layout 层上方
    await parseElements(item.layoutElements);
    await parseElements(item.elements);
    slides.push(slide);
  }

  return { slides, uploadTasks };
}
