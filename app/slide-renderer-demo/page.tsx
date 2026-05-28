'use client';

import { SlideCanvas, type Slide } from 'slide-renderer';

const demoSlide: Slide = {
  id: 'demo-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: {
    backgroundColor: '#ffffff',
    themeColors: ['#5b8def', '#5b8def'],
    fontColor: '#1f2937',
    fontName: 'system-ui, -apple-system, sans-serif',
  },
  background: {
    type: 'gradient',
    gradient: {
      type: 'linear',
      colors: [
        { pos: 0, color: '#eef2ff' },
        { pos: 100, color: '#ffffff' },
      ],
      rotate: 135,
    },
  },
  elements: [
    {
      type: 'shape',
      id: 's1',
      left: 60,
      top: 80,
      width: 880,
      height: 64,
      rotate: 0,
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
      fixedRatio: false,
      fill: '#5b8def',
      opacity: 1,
    },
    {
      type: 'text',
      id: 't1',
      left: 60,
      top: 80,
      width: 880,
      height: 64,
      rotate: 0,
      content:
        '<p style="text-align:center; color:#ffffff; font-size:32px; font-weight:600; margin:0; padding:12px 0">slide-renderer demo</p>',
      defaultFontName: 'system-ui, sans-serif',
      defaultColor: '#ffffff',
    },
    {
      type: 'text',
      id: 't2',
      left: 60,
      top: 180,
      width: 880,
      height: 60,
      rotate: 0,
      content:
        '<p style="font-size:18px; color:#4b5563; margin:0">React component for rendering PPTist-style <code style="background:#f3f4f6; padding:2px 6px; border-radius:4px">Slide</code> JSON.</p>',
      defaultFontName: 'system-ui, sans-serif',
      defaultColor: '#4b5563',
    },
    {
      type: 'shape',
      id: 's2',
      left: 60,
      top: 280,
      width: 280,
      height: 220,
      rotate: 0,
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
      fixedRatio: false,
      fill: '#fef3c7',
      opacity: 1,
      outline: { width: 2, color: '#f59e0b', style: 'solid' },
      text: {
        content:
          '<p style="font-size:14px; color:#92400e; margin:0; text-align:center">Pure props.<br/>Zero global state.</p>',
        defaultFontName: 'system-ui, sans-serif',
        defaultColor: '#92400e',
        align: 'middle',
      },
    },
    {
      type: 'shape',
      id: 's3',
      left: 360,
      top: 280,
      width: 280,
      height: 220,
      rotate: 0,
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
      fixedRatio: false,
      fill: '#dbeafe',
      opacity: 1,
      outline: { width: 2, color: '#3b82f6', style: 'solid' },
      text: {
        content:
          '<p style="font-size:14px; color:#1e3a8a; margin:0; text-align:center">Auto-fit viewport<br/>via ResizeObserver.</p>',
        defaultFontName: 'system-ui, sans-serif',
        defaultColor: '#1e3a8a',
        align: 'middle',
      },
    },
    {
      type: 'shape',
      id: 's4',
      left: 660,
      top: 280,
      width: 280,
      height: 220,
      rotate: 0,
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
      fixedRatio: false,
      fill: '#ede9fe',
      opacity: 1,
      outline: { width: 2, color: '#8b5cf6', style: 'solid' },
      text: {
        content:
          '<p style="font-size:14px; color:#4c1d95; margin:0; text-align:center">renderImage /<br/>renderVideo slots.</p>',
        defaultFontName: 'system-ui, sans-serif',
        defaultColor: '#4c1d95',
        align: 'middle',
      },
    },
  ],
};

export default function SlideRendererDemoPage() {
  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <h1 className="mb-2 text-2xl font-semibold text-gray-900">slide-renderer demo</h1>
      <p className="mb-6 text-sm text-gray-600">
        Single handwritten <code>Slide</code> rendered by the workspace package. Resize the window
        to see auto-fit in action.
      </p>
      <div className="mx-auto h-[562px] w-full max-w-[1000px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <SlideCanvas slide={demoSlide} />
      </div>
    </div>
  );
}
