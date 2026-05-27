# 🎨 pptxtojson

<p>
    <a href="https://www.github.com/pipipi-pikachu/pptxtojson/stargazers" target="_black"><img src="https://img.shields.io/github/stars/pipipi-pikachu/pptxtojson?logo=github" alt="stars" /></a>
    <a href="https://www.github.com/pipipi-pikachu/pptxtojson/network/members" target="_black"><img src="https://img.shields.io/github/forks/pipipi-pikachu/pptxtojson?logo=github" alt="forks" /></a>
    <a href="https://www.github.com/pipipi-pikachu/pptxtojson/blob/master/LICENSE" target="_black"><img src="https://img.shields.io/github/license/pipipi-pikachu/pptxtojson?logo=github" alt="license" /></a>
    <a href="https://github.com/pipipi-pikachu/pptxtojson/issues" target="_black"><img src="https://img.shields.io/github/issues-closed/pipipi-pikachu/pptxtojson?logo=github" alt="issue"></a>
    <a href="https://gitee.com/pptist/pptxtojson" target="_black"><img src="https://gitee.com/pptist/pptxtojson/badge/star.svg?version=latest" alt="gitee"></a>
    <a href="https://gitcode.com/pipipi-pikachu/pptxtojson" target="_black"><img src="https://gitcode.com/pipipi-pikachu/pptxtojson/star/badge.svg" alt="gitcode"></a>
</p>

一个运行在浏览器中，可以将 .pptx 文件转为可读的 JSON 数据的 JavaScript 库。

**实现说明**：主入口为 TypeScript 实现（`src/`），构建产物为 `dist/`；输出 JSON 格式与文档及原示例一致。原 JavaScript 实现位于 `src1/`，仅作输出格式与逻辑参考，不参与构建。

> 与其他的pptx文件解析工具的最大区别在于：
> 1. 直接运行在浏览器端；
> 2. 解析结果是**可读**的 JSON 数据，而不仅仅是把 XML 文件内容原样翻译成难以理解的 JSON。

在线DEMO：https://pipipi-pikachu.github.io/pptxtojson/

> 国内镜像（定期同步）：[Gitee](https://gitee.com/pptist/pptxtojson)、[GitCode](https://gitcode.com/pipipi-pikachu/pptxtojson)

# 🎯 注意事项
### ⚒️ 使用场景
本仓库诞生于项目 [PPTist](https://github.com/pipipi-pikachu/PPTist) ，希望为其“导入 .pptx 文件功能”提供一个参考示例。不过就目前来说，解析出来的PPT信息与源文件在样式上还是存在差异。

但如果你只是需要提取PPT文件的文本内容、媒体资源信息、结构信息等，或者对排版/样式精准度没有特别高的要求，那么 pptxtojson 可能会对你有帮助。

### 📏 长度值单位
输出的JSON中，所有数值长度值单位都为`pt`（point）
> 注意：在0.x版本中，所有输出的长度值单位都是px（像素）

# 🔨安装
```
npm install pptxtojson
```

# 💿用法

### 浏览器
```html
<input type="file" accept="application/vnd.openxmlformats-officedocument.presentationml.presentation"/>
```

```javascript
import { parse } from 'pptxtojson'

document.querySelector('input').addEventListener('change', evt => {
	const file = evt.target.files[0]
	
	const reader = new FileReader()
	reader.onload = async e => {
		const json = await parse(e.target.result)
		console.log(json)
	}
	reader.readAsArrayBuffer(file)
})
```

### Node.js(实验性，1.5.0以上版本)
```javascript
const pptxtojson = require('pptxtojson/dist/index.cjs')
const fs = require('fs')

async function func() {
  const buffer = fs.readFileSync('test.pptx')

  const json = await pptxtojson.parse(buffer.buffer)
  console.log(json)
}

func()
```

### 输出示例
```javascript
{
	"slides": [
		{
			"fill": {
				"type": "color",
				"value": "#FF0000"
			},
			"elements": [
				{
					"left":	0,
					"top": 0,
					"width": 72,
					"height":	72,
					"borderColor": "#1F4E79",
					"borderWidth": 1,
					"borderType": "solid",
					"borderStrokeDasharray": 0,
					"fill": {
						"type": "color",
						"value": "#FF0000"
					},
					"content": "<p style=\"text-align: center;\"><span style=\"font-size: 18pt;font-family: Calibri;\">TEST</span></p>",
					"isFlipV": false,
					"isFlipH": false,
					"rotate": 0,
					"vAlign": "mid",
					"name": "矩形 1",
					"type": "shape",
					"shapType": "rect"
				},
				// more...
			],
			"layoutElements": [
				// more...
			],
			"note": "演讲者备注内容..."
		},
		// more...
	],
	"themeColors": ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
	"size": {
		"width": 960,
		"height": 540
	}
}
```

# 📕 完整功能支持

- 幻灯片主题色 `themeColors`

- 幻灯片尺寸 `size`
	- 宽度 `width`
	- 高度 `height`

- 幻灯片页面 `slides`

	- 页面备注 `note`

	- 页面背景填充（颜色、图片、渐变、图案） `fill`
		- 纯色填充 `type='color'`
		- 图片填充 `type='image'`
		- 渐变填充 `type='gradient'`
		- 图案填充 `type='pattern'`

	- 页面切换动画 `transition`
		- 类型 `type`
		- 持续时间 `duration`
		- 方向 `direction`

	- 页面内元素 `elements` / 母版元素 `layoutElements`
		- 文字
			- 类型 `type='text'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框颜色 `borderColor`
			- 边框宽度 `borderWidth`
			- 边框类型（实线、点线、虚线） `borderType`
			- 非实线边框样式 `borderStrokeDasharray`
			- 阴影 `shadow`
			- 填充（颜色、图片、渐变、图案） `fill`
			- 内容文字（HTML富文本：字体、字号、颜色、渐变、下划线、删除线、斜体、加粗、阴影、角标、超链接） `content`
			- 垂直翻转 `isFlipV`
			- 水平翻转 `isFlipH`
			- 旋转角度 `rotate`
			- 垂直对齐方向 `vAlign`
			- 是否为竖向文本 `isVertical`
			- 元素名 `name`
			- 自动调整大小 `autoFit`
				- 类型 `type`
					- `shape`：文本框高度会根据文本内容自动调整
					- `text`：文本框大小固定，字号会自动缩放以适应文本框（注：autoFit不存在时，也会固定文本框大小，但字号不会缩放）
				- 字体缩放比例（type='text'专有，默认为1） `fontScale`
			- 超链接 `link`

		- 图片
			- 类型 `type='image'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框颜色 `borderColor`
			- 边框宽度 `borderWidth`
			- 边框类型（实线、点线、虚线） `borderType`
			- 非实线边框样式 `borderStrokeDasharray`
			- 裁剪形状 `geom`
			- 裁剪范围 `rect`
			- 图片地址（base64） `src`
			- 旋转角度 `rotate`
			- 滤镜 `filters`
			- 超链接 `link`

		- 形状
			- 类型 `type='shape'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框颜色 `borderColor`
			- 边框宽度 `borderWidth`
			- 边框类型（实线、点线、虚线） `borderType`
			- 非实线边框样式 `borderStrokeDasharray`
			- 阴影 `shadow`
			- 填充（颜色、图片、渐变、图案） `fill`
			- 内容文字（HTML富文本，与文字元素一致） `content`
			- 垂直翻转 `isFlipV`
			- 水平翻转 `isFlipH`
			- 旋转角度 `rotate`
			- 形状类型 `shapType`
			- 垂直对齐方向 `vAlign`
			- 形状路径 `path`
			- 形状调整参数 `keypoints`
			- 元素名 `name`
			- 自动调整大小 `autoFit`
			- 超链接 `link`

		- 表格
			- 类型 `type='table'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 边框（4边） `borders`
			- 表格数据 `data`
			- 行高 `rowHeights`
			- 列宽 `colWidths`

		- 图表
			- 类型 `type='chart'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 图表数据 `data`
			- 图表主题色 `colors`
			- 图表类型 `chartType`
			- 柱状图方向 `barDir`
			- 是否带数据标记 `marker`
			- 环形图尺寸 `holeSize`
			- 分组模式 `grouping`
			- 图表样式 `style`

		- 视频
			- 类型 `type='video'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 视频blob `blob`
			- 视频src `src`

		- 音频
			- 类型 `type='audio'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 音频blob `blob`

		- 公式
			- 类型 `type='math'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 公式图片 `picBase64`
			- LaTeX表达式（仅支持常见结构） `latex`
			- 文本（文本和公式混排时存在） `text`

		- Smart图
			- 类型 `type='diagram'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 子元素集合 `elements`
			- 文本列表（Smart图中的文字内容清单，仅在elements无法解析时存在） `textList`

		- 多元素组合
			- 类型 `type='group'`
			- 水平坐标 `left`
			- 垂直坐标 `top`
			- 宽度 `width`
			- 高度 `height`
			- 子元素集合 `elements`

### 更多类型请参考 👇
[https://github.com/pipipi-pikachu/pptxtojson/blob/master/dist/index.d.ts](https://github.com/pipipi-pikachu/pptxtojson/blob/master/dist/index.d.ts)

# 🙏 感谢
本仓库大量参考了 [PPTX2HTML](https://github.com/g21589/PPTX2HTML) 和 [PPTXjs](https://github.com/meshesha/PPTXjs) 的实现。
> 与它们不同的是：PPTX2HTML 和 PPTXjs 是将PPT文件转换为能够运行的 HTML 页面，而 pptxtojson 做的是将PPT文件转换为干净的 JSON 数据，且在原有基础上进行了大量优化补充（包括代码质量和提取信息的完整度和准确度）。

# 📄 开源协议
MIT License | Copyright © 2020-PRESENT [pipipi-pikachu](https://github.com/pipipi-pikachu)