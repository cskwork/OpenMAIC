'use client';

import { useCallback, useEffect, useState } from 'react';
import { SlideCanvas, type Slide } from 'slide-renderer';
import { useImportPptx } from '@/lib/import/use-import-pptx';
import { cn } from '@/lib/utils/cn';

interface StoredCanvas {
  component_id: string;
  component_type: string;
  content: {
    id: string;
    // Real decks carry shape/table fields the package's element types don't
    // enumerate yet (pathFormula 'roundRect', TableCell.vAlign, …). They're
    // valid runtime data, so keep them loose here and cast at the boundary.
    elements: unknown[];
    background?: Slide['background'];
    script?: string;
    canvas_width: number;
    canvas_height: number;
  };
  created_at?: string | null;
  updated_at?: string | null;
}

// Elements are laid out in the deck's native pixel space (canvas_width ×
// canvas_height, e.g. 1280×720). SlideCanvas derives the canvas size from
// viewportSize × viewportRatio, so map the pixel canvas onto those — that makes
// the logical canvas match the element coordinates (everything sits inside it),
// and SlideCanvas then scales the whole canvas proportionally to fit.
const DEMO_THEME: Slide['theme'] = {
  backgroundColor: '#ffffff',
  themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
  fontColor: '#333333',
  fontName: '',
};

function storedToSlide(c: StoredCanvas): Slide {
  return {
    id: c.content.id,
    elements: c.content.elements as Slide['elements'],
    background: c.content.background,
    viewportSize: c.content.canvas_width,
    viewportRatio: c.content.canvas_height / c.content.canvas_width,
    theme: DEMO_THEME,
  };
}

const demoSlides: StoredCanvas[] = [
  {
    component_id: 'p6w8WMVeyBk0PQQnMUwXH',
    component_type: 'canvas',
    content: {
      id: 'UhotAd859y',
      elements: [
        {
          type: 'image',
          id: 'ivCQtdr9GL',
          src: 'https://file-test.maic.chat/a2m/6613bcc3e73e1bf232058ac3/DoSBW_PcUUTXI0Kf.png',
          width: 46.60719999999999,
          height: 38.4344,
          left: 10.4796,
          top: 50.51626666666667,
          fixedRatio: true,
          rotate: 4.660433333333334,
          flipH: true,
          flipV: false,
        },
        {
          type: 'table',
          id: 'oDzlE--zfQ',
          width: 1256.9333333333332,
          height: 628.7333333333333,
          left: 12.533333333333333,
          top: 65,
          colWidths: [
            0.058714331176408195,
            0.07823273575899015,
            0.1854248435345285,
            0.13105972207489128,
            0.1500477352285987,
            0.19189561896679752,
            0.20462501325978574,
          ],
          rotate: 0,
          data: [
            [
              {
                id: 'gYucEswycN',
                colspan: 1,
                rowspan: 1,
                text: '<p>地质</p><p>年代</p>',
                vAlign: 'top',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'center',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'G0wTeddDay',
                colspan: 1,
                rowspan: 1,
                text: '<p>年代</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'center',
                  fontsize: '21.3px',
                },
              },
              {
                id: '2EnHsfMoLr',
                colspan: 1,
                rowspan: 1,
                text: '<p>关键事件</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'center',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'ynTZfy8Ie1',
                colspan: 1,
                rowspan: 1,
                text: '<p>大气CO₂</p><p>浓度</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'center',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'v_aWwSRV0G',
                colspan: 1,
                rowspan: 1,
                text: '<p>气候变化</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'center',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'FeyVNGH3jt',
                colspan: 1,
                rowspan: 1,
                text: '<p>主要植被类型</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'center',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'rrJA5dnWG1',
                colspan: 1,
                rowspan: 1,
                text: '<p>兔子特征及演化情况</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'center',
                  fontsize: '21.3px',
                },
              },
            ],
            [
              {
                id: 'gx3WXxvB37',
                colspan: 1,
                rowspan: 1,
                text: '<p>古新世</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'VcYwlJz0hO',
                colspan: 1,
                rowspan: 1,
                text: '<p>6200万年前</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'uN0T1XepsQ',
                colspan: 1,
                rowspan: 1,
                text: '<p>喜马拉雅造山未大规模启动</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'WPWG59X9sv',
                colspan: 1,
                rowspan: 1,
                text: '<p>0.1%–0.15%（远高于现今）</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'CasOPr0qCL',
                colspan: 1,
                rowspan: 1,
                text: '<p>全球暖湿，气温高且稳定，降水充沛</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'Az-7fcQyVm',
                colspan: 1,
                rowspan: 1,
                text: '<p>以C3植物为主，全球森林广泛分布，无开阔草原</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'u1EWjkVPrD',
                colspan: 1,
                rowspan: 1,
                text: '<p>出现安徽模鼠兔，小型林栖，食C3软叶，多样性低</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
            ],
            [
              {
                id: '_TpEM41Cr8',
                colspan: 1,
                rowspan: 1,
                text: '<p>始新世</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'f8-jUy73yp',
                colspan: 1,
                rowspan: 1,
                text: '<p>5300–</p><p>4000万年前</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'FIdEMbMicj',
                colspan: 1,
                rowspan: 1,
                text: '<p>喜马拉雅造山启动，发生始新世极热事件。（火山爆发）</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'rD6vAew_K1',
                colspan: 1,
                rowspan: 1,
                text: '<p>0.1%–0.12%</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: '8Nua2Bv4uG',
                colspan: 1,
                rowspan: 1,
                text: '<p>延续暖湿，气温略低于古新世，局部有干暖波动</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'IL27uugRnn',
                colspan: 1,
                rowspan: 1,
                text: '<p>以C3植物为主，森林广布，局部出现少量草本植物</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'sYLQ7WQsoR',
                colspan: 1,
                rowspan: 1,
                text: '<p>出现远古道森兔，兔形目分化为鼠兔科（穴居）和兔科（向开阔环境试探）</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
            ],
            [
              {
                id: '1M2Ezyfp9m',
                colspan: 1,
                rowspan: 1,
                text: '<p>渐新世–中新世</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: '3u3K9etzLt',
                colspan: 1,
                rowspan: 1,
                text: '<p>3400–</p><p>500万年前</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'FF0m4gHY9s',
                colspan: 1,
                rowspan: 1,
                text: '<p>喜马拉雅造山持续推进，全球变冷变干（一种吸收空气中二氧化碳的物质暴露出来）；</p><p>2300万年前CO₂阶段性升高</p><p>1200万年前再次降低</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'AOcR1ZbCwP',
                colspan: 1,
                rowspan: 1,
                text: '<p>从0.1%降至0.02%–0.03%，2300万年前阶段性升至0.045%</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: '2qkAHGA_Ct',
                colspan: 1,
                rowspan: 1,
                text: '<p>显著变冷变变干，冷暖波动加剧，干旱区域扩大</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'l72dSZTRt9',
                colspan: 1,
                rowspan: 1,
                text: '<p>C3植物退缩，C4植物扩张，逐步形成大规模草原、荒漠</p><p>2300万年前CO₂阶段性升高，C4退缩</p><p>1200万年前，C4继续扩张</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'bzpvyyrn4S',
                colspan: 1,
                rowspan: 1,
                text: '<p>兔科快速分化，适配C4植物；</p><p>2300万年前演化中心移至北美，（种类骤减）</p><p>1200万年前重返亚欧；鼠兔科适应高原环境</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
            ],
            [
              {
                id: '44NDfwOpCG',
                colspan: 1,
                rowspan: 1,
                text: '<p>上新世–第四纪</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: '6Y43T3LHzZ',
                colspan: 1,
                rowspan: 1,
                text: '<p>500万年前–现在</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'zObKIiOneL',
                colspan: 1,
                rowspan: 1,
                text: '<p>喜马拉雅造山趋于稳定，第四纪冰期启动，人类活动影响生态</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: '6ImNVFiANq',
                colspan: 1,
                rowspan: 1,
                text: '<p>低浓度波动，近现代升至0.042%</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'bxR4b723Hc',
                colspan: 1,
                rowspan: 1,
                text: '<p>长期冷干，冰期-间冰期交替，近现代气温上升</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'WeVPNg0EU_',
                colspan: 1,
                rowspan: 1,
                text: '<p>C4草原、荒漠为主，间冰期C3植物在温带、高海拔分布</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
              {
                id: 'WCJj0VtU4d',
                colspan: 1,
                rowspan: 1,
                text: '<p>现代兔子成型，兔科遍布全球，鼠兔科稳定分布于高原及周边</p>',
                vAlign: 'middle',
                padding: '3.6pt 7.2pt',
                style: {
                  fontname: 'SourceHanSans',
                  color: 'rgb(0, 0, 0)',
                  align: 'left',
                  fontsize: '21.3px',
                },
              },
            ],
          ],
          outline: {
            width: 1,
            style: 'solid',
            color: '#DEE0E3',
          },
          cellMinHeight: 22.8,
          rowHeights: [22.8, 100.33333333333333, 136, 195.33333333333331, 112.26666666666667],
        },
        {
          type: 'text',
          id: 'I2uQ8q_YoM',
          width: 704,
          height: 60.28,
          left: 307.4,
          top: 12.2,
          rotate: 0,
          defaultFontName: '',
          defaultColor: '#333',
          content:
            '<div style="padding: 4.8px 9.6px 4.8px 9.6px;"><p style="text-align: center;margin-left: 0px;text-indent: 0px;line-height: 1;"><span style="font-size: 37.3px;color: #3a7b7d;font-family: SourceHanSans;font-kerning: normal;">喜马拉雅成就"兔兔大业"</span></p></div>',
          lineHeight: 1,
          fill: 'transparent',
          vertical: false,
        },
        {
          type: 'text',
          id: '544hWEkqhH',
          width: 1245.6399999999999,
          height: 42.53333333333333,
          left: 29.199999999999996,
          top: 676.9333333333333,
          rotate: 0,
          defaultFontName: '',
          defaultColor: '#333',
          content:
            '<div style="padding: 4.8px 9.6px 4.8px 9.6px;"><p style="text-align: left;margin-left: 0px;"><span style="font-size: 24.0px;color: #000000;font-family: SourceHanSans;font-kerning: normal;">补充：二氧化碳是一种温室气体，越少，越冷，越冷水循环（水份蒸发最终形成雨）不够，就越干。</span></p></div>',
          lineHeight: 1,
          fill: 'transparent',
          vertical: false,
        },
      ],
      background: {
        type: 'image',
        image: {
          src: 'https://file-test.maic.chat/a2m/6613bcc3e73e1bf232058ac3/kw2V9MczaQg-SsyO.png',
          size: 'cover',
        },
      },
      script:
        '从地质年代角度看，喜马拉雅的隆起对"兔兔大业"起到了关键作用。这里和二氧化碳含量密切相关，二氧化碳作为温室气体，其含量影响着气候。当二氧化碳变少，气候会变冷，接着水循环也会受影响。因为越冷水循环就越不足，水分蒸发少最终导致降雨不够，气候变得干旱。这一系列变化或许为兔子的进化等创造了特定环境，喜马拉雅的隆起改变了地理环境、气候条件等，或许为兔子开拓出新的生存空间和演化机遇。',
      canvas_width: 1280,
      canvas_height: 720,
    },
    created_at: null,
    updated_at: null,
  },
];
export default function SlideRendererDemoPage() {
  const [slides, setSlides] = useState<Slide[]>(() => demoSlides.map(storedToSlide));
  const [activeIndex, setActiveIndex] = useState(0);

  const { importing, fileInputRef, triggerFileSelect, handleFileChange } = useImportPptx({
    // No remote OSS in this demo: hand every media blob a local object URL so
    // images become `blob:` refs instead of base64. Valid for the current tab
    // only — fine here since the deck is discarded on refresh.
    upload: async (blob) => URL.createObjectURL(blob),
    // The hook yields the app-internal Slide type; the package re-declares an
    // identical shape, so cross the boundary with a structural cast.
    onImported: (imported) => {
      if (!imported.length) return;
      // Importer now sets viewportSize from the deck's actual pixel width
      // (1280 for 16:9 widescreen, 960 for 4:3) — pass through unchanged.
      setSlides(imported as unknown as Slide[]);
      setActiveIndex(0);
    },
  });

  const active = slides[activeIndex] ?? slides[0];
  const ratio = active?.viewportRatio || 0.5625;

  const go = useCallback((next: number) => {
    setSlides((current) => {
      setActiveIndex(Math.max(0, Math.min(next, current.length - 1)));
      return current;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        go(activeIndex + 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go(activeIndex - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIndex, go]);

  return (
    <div className="flex h-screen flex-col bg-gray-100">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onChange={handleFileChange}
        className="hidden"
      />

      <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-3">
        <h1 className="text-lg font-semibold text-gray-900">slide-renderer demo</h1>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
          {slides.length} 张幻灯片
        </span>
        <button
          type="button"
          onClick={triggerFileSelect}
          disabled={importing}
          className="ml-auto inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {importing ? '导入中…' : '导入 PPTX'}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-2 overflow-y-auto border-r border-gray-200 bg-white p-3">
          {slides.map((s, i) => (
            <button
              key={s.id ?? i}
              type="button"
              onClick={() => go(i)}
              className={cn(
                'flex w-full items-start gap-2 rounded-md p-1 text-left transition',
                i === activeIndex ? 'bg-violet-50' : 'hover:bg-gray-100',
              )}
            >
              <span className="w-4 shrink-0 pt-1 text-right text-xs text-gray-400">{i + 1}</span>
              <div
                className={cn(
                  'relative w-full overflow-hidden rounded bg-white ring-1',
                  i === activeIndex ? 'ring-2 ring-violet-500' : 'ring-gray-200',
                )}
                style={{ aspectRatio: `${1 / (s.viewportRatio || 0.5625)}` }}
              >
                <div className="pointer-events-none absolute inset-0">
                  <SlideCanvas slide={s} />
                </div>
              </div>
            </button>
          ))}
        </aside>

        <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8">
          {active ? (
            <div
              key={active.id ?? activeIndex}
              className="bg-white shadow-xl ring-1 ring-black/5"
              style={{
                width: '100%',
                maxWidth: `calc((100vh - 9rem) * ${1 / ratio})`,
                aspectRatio: `${1 / ratio}`,
              }}
            >
              <SlideCanvas slide={active} />
            </div>
          ) : (
            <p className="text-sm text-gray-500">导入一个 PPTX 文件开始预览</p>
          )}
        </main>
      </div>
    </div>
  );
}
