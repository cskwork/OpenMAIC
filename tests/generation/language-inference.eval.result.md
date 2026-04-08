# Language Inference Eval Results

- **Date**: 2026-04-08T12:27:29.786Z
- **Passed**: 17/17 (100%)
- **Model**: (default)
- **Method**: outline generation pipeline (merged) + LLM-as-judge

## Detail

### PASS Pure Chinese requirement

- **Input**: `从零学 Python，适合初中生`
- **Ground truth**: Teaching language: Chinese. Programming terms like Python, variable, function should be kept in English.
- **Directive**: 用中文授课。编程术语如 Python、variable、function 等保留英文原文，首次出现时附简短中文解释。
- **Scenes**: 7
- **Judge**: PASS — The directive correctly specifies Chinese as the teaching language and appropriately retains programming terms in English while providing brief Chinese explanations, aligning well with the requirement.

### PASS Pure English requirement

- **Input**: `Explain quantum computing for high school students`
- **Ground truth**: Teaching language: English. Scientific terms like qubit, superposition can be kept as-is or explained in accessible language for the target audience.
- **Directive**: Teach quantum computing in English for high school students. Keep technical terms such as 'quantum bit', 'superposition', and 'entanglement' in English, providing simple explanations for each.
- **Scenes**: 6
- **Judge**: PASS — The directive correctly specifies English as the teaching language and appropriately addresses the handling of technical terms by keeping them in English while providing simple explanations, which aligns with the requirement.

### PASS Japanese requirement

- **Input**: `Pythonの基礎を学びたいです。初心者向けにお願いします`
- **Ground truth**: Teaching language: Japanese. Programming terms like Python should be kept in English.
- **Directive**: 日本語で授業を行います。Python関連の用語は英語のまま使用し、初出時に日本語の説明を付けます。
- **Scenes**: 6
- **Judge**: PASS — The directive correctly identifies Japanese as the teaching language and appropriately handles Python-related terminology by keeping it in English while providing Japanese explanations, which aligns with the requirement.

### PASS Korean requirement

- **Input**: `파이썬 기초를 배우고 싶습니다. 초보자용으로 부탁드립니다`
- **Ground truth**: Teaching language: Korean. Programming terms like Python should be kept in English.
- **Directive**: 용 한국어로 강의합니다. 프로그래밍 용어인 Python, 변수, 함수 등은 영어 원어를 그대로 사용하며, 처음 등장할 때 간단한 한국어 설명을 추가합니다.
- **Scenes**: 6
- **Judge**: PASS — The directive correctly identifies Korean as the teaching language and appropriately handles programming terminology by using English terms with simple Korean explanations, which aligns with the requirement.

### PASS Chinese user wants English course

- **Input**: `帮我准备一堂英语课，初中水平`
- **Ground truth**: Teaching language: Chinese. This is a Chinese student learning English at middle school level. The course should be taught primarily in Chinese, with English vocabulary, phrases and example sentences introduced progressively. Bilingual approach.
- **Directive**: 用中文授课，教授英语基础知识。英语词汇和例句逐步引入，用中文解释语法和用法。
- **Scenes**: 4
- **Judge**: PASS — The directive correctly identifies Chinese as the teaching language and outlines a reasonable bilingual approach by introducing English vocabulary and grammar with Chinese explanations.

### PASS Chinese user learning Japanese

- **Input**: `帮我做一个日语入门课程，从五十音图开始`
- **Ground truth**: Teaching language: Chinese. This is a complete beginner learning Japanese (starting from the fifty-sound chart). The course must be taught in Chinese with Japanese content introduced and explained in Chinese. Bilingual approach.
- **Directive**: 用中文授课，教授日语入门内容。五十音图及日语词汇用中文讲解，逐步引入日语表达。
- **Scenes**: 5
- **Judge**: PASS — The directive correctly identifies Chinese as the teaching language and reasonably explains the introduction of Japanese content, aligning with the requirement for a beginner Japanese course.

### PASS Japanese user wants English teaching

- **Input**: `英語でPythonを教えてください`
- **Ground truth**: Teaching language: English (explicitly requested by the user). The user is a native Japanese speaker. Programming terms should be kept in English. May provide Japanese explanations for difficult concepts.
- **Directive**: Teach Python in English. The student is a native Japanese speaker, so provide Japanese translations for difficult concepts. Keep programming terms in English.
- **Scenes**: 5
- **Judge**: PASS — The directive correctly identifies English as the teaching language and appropriately addresses the needs of a native Japanese speaker by including Japanese translations for difficult concepts while keeping programming terms in English.

### PASS Chinese user with English PDF

- **Input**: `用中文讲解这篇论文` (PDF: "Abstract: This paper presents a novel ap...")
- **Ground truth**: Teaching language: Chinese. The source document is in English, so English technical terms should be shown alongside Chinese translations when first introduced.
- **Directive**: 用中文授课。论文的专有名词和技术术语将在原文中保留英文，以便学生对照理解。
- **Scenes**: 4
- **Judge**: PASS — The directive uses the correct primary teaching language (Chinese) and reasonably handles terminology by retaining English terms for clarity, which aligns with the requirement.

### PASS English user with Chinese PDF

- **Input**: `Explain this paper in English` (PDF: "摘要：本文提出了一种基于Transformer的语言模型新方法，在少样本学习性能...")
- **Ground truth**: Teaching language: English. The source document is in Chinese but technical terms are already in English, so just teach in English naturally.
- **Directive**: Teach in English. The course will explain the concepts presented in the paper, retaining technical terms in English while providing concise explanations.
- **Scenes**: 4
- **Judge**: PASS — The directive correctly specifies English as the teaching language and reasonably addresses the retention of technical terms in English while providing explanations, aligning with the requirement.

### PASS Chinese technical course (React hooks)

- **Input**: `讲一下 React hooks 的原理，包括 useState 和 useEffect`
- **Ground truth**: Teaching language: Chinese. Programming terms like React, hooks, useState, useEffect should be kept in English.
- **Directive**: 用中文授课。React、useState 和 useEffect 等术语保留英文原文，首次出现时附简短中文解释。
- **Scenes**: 5
- **Judge**: PASS — The directive correctly specifies Chinese as the teaching language and appropriately retains English terms while providing brief Chinese explanations, aligning well with the requirement.

### PASS Chinese course on machine learning

- **Input**: `机器学习入门：监督学习和非监督学习`
- **Ground truth**: Teaching language: Chinese. Technical terms like Machine Learning, supervised/unsupervised learning should be kept in English or shown bilingually.
- **Directive**: 用中文授课，教授机器学习的基础概念。专业术语如监督学习、非监督学习等保留英文原文，并附中文解释。
- **Scenes**: 4
- **Judge**: PASS — The directive correctly uses Chinese as the teaching language and appropriately retains technical terms in English while providing Chinese explanations, aligning well with the requirement.

### PASS Mixed Chinese-English requirement

- **Input**: `做一个 Next.js 14 的 tutorial，用中文讲`
- **Ground truth**: Teaching language: Chinese. Technical terms like Next.js should be kept in English.
- **Directive**: 用中文授课。编程术语如 Next.js、React 等保留英文原文，并附上简短中文解释以便理解。
- **Scenes**: 7
- **Judge**: PASS — The directive uses the correct primary teaching language (Chinese) and appropriately handles technical terminology by retaining English terms while providing brief Chinese explanations.

### PASS Extremely short requirement (Chinese)

- **Input**: `讲讲光合作用`
- **Ground truth**: Teaching language: Chinese. Biology terms should use standard Chinese translations (e.g., 光合作用, 叶绿体).
- **Directive**: 用中文授课，讲解光合作用的基本概念和过程。生物学术语使用中文标准译名。
- **Scenes**: 4
- **Judge**: PASS — The directive correctly specifies Chinese as the teaching language and appropriately addresses the use of standard Chinese translations for biological terms, aligning well with the requirement.

### PASS Extremely short requirement (English) + English locale

- **Input**: `Photosynthesis` (Locale: en-US)
- **Ground truth**: Teaching language: English. Biology terms should use standard English terminology.
- **Directive**: Teach in English. Keep scientific terms like 'photosynthesis', 'chlorophyll', and 'stomata' in English while providing clear explanations.
- **Scenes**: 5
- **Judge**: PASS — The directive correctly specifies English as the teaching language and appropriately handles scientific terminology by keeping key terms in English while ensuring clear explanations are provided.

### PASS Ambiguous requirement + Chinese user bio

- **Input**: `Photosynthesis` (Bio: "计算机专业大三学生")
- **Ground truth**: Teaching language: Chinese (inferred from user bio being in Chinese). Biology terms should use Chinese translations.
- **Directive**: 用中文授课。生物学术语使用中文标准译名，如'光合作用''叶绿体''气孔'等。
- **Scenes**: 4
- **Judge**: PASS — The directive correctly specifies the teaching language as Chinese and appropriately uses standard Chinese translations for biological terms, aligning with the user requirement.

### PASS Ambiguous requirement + Japanese browser locale

- **Input**: `Machine Learning` (Locale: ja-JP)
- **Ground truth**: Teaching language: Japanese (inferred from browser locale). Technical terms like Machine Learning should be kept in English.
- **Directive**: 日本語で授業を行います。Machine Learning、Algorithm、Dataなどの技術用語は英語のまま使用し、初出時に日本語の説明を付けます。
- **Scenes**: 4
- **Judge**: PASS — The directive correctly identifies Japanese as the teaching language and appropriately retains technical terms in English while providing Japanese explanations, aligning with the requirement.

### PASS Chinese user with Japanese PDF

- **Input**: `帮我分析这篇日文文献` (PDF: "この研究では、深層学習モデルを用いた自然言語処理の新しいアプローチを提案する。実...")
- **Ground truth**: Teaching language: Chinese (requirement is written in Chinese). The source document is in Japanese, so Japanese terms should be shown alongside Chinese translations.
- **Directive**: 用中文授课。文献原文为日文，专业术语首次出现时保留日文原文并附中文翻译，方便学生对照理解。
- **Scenes**: 3
- **Judge**: PASS — The directive correctly identifies Chinese as the teaching language and appropriately handles the Japanese terminology by providing both the original Japanese terms and their Chinese translations for better understanding.

## Summary

| # | Case | Result | Scenes | Directive | Judge reason |
|---|------|--------|--------|-----------|--------------|
| 1 | Pure Chinese requirement | PASS | 7 | 用中文授课。编程术语如 Python、variable、function 等保留英文原文，首次出现时附简短中文解释。 | The directive correctly specifies Chinese as the teaching language and appropriately retains programming terms in English while providing brief Chinese explanations, aligning well with the requirement. |
| 2 | Pure English requirement | PASS | 6 | Teach quantum computing in English for high school students. Keep technical terms such as 'quantum bit', 'superposition', and 'entanglement' in English, providing simple explanations for each. | The directive correctly specifies English as the teaching language and appropriately addresses the handling of technical terms by keeping them in English while providing simple explanations, which aligns with the requirement. |
| 3 | Japanese requirement | PASS | 6 | 日本語で授業を行います。Python関連の用語は英語のまま使用し、初出時に日本語の説明を付けます。 | The directive correctly identifies Japanese as the teaching language and appropriately handles Python-related terminology by keeping it in English while providing Japanese explanations, which aligns with the requirement. |
| 4 | Korean requirement | PASS | 6 | 용 한국어로 강의합니다. 프로그래밍 용어인 Python, 변수, 함수 등은 영어 원어를 그대로 사용하며, 처음 등장할 때 간단한 한국어 설명을 추가합니다. | The directive correctly identifies Korean as the teaching language and appropriately handles programming terminology by using English terms with simple Korean explanations, which aligns with the requirement. |
| 5 | Chinese user wants English course | PASS | 4 | 用中文授课，教授英语基础知识。英语词汇和例句逐步引入，用中文解释语法和用法。 | The directive correctly identifies Chinese as the teaching language and outlines a reasonable bilingual approach by introducing English vocabulary and grammar with Chinese explanations. |
| 6 | Chinese user learning Japanese | PASS | 5 | 用中文授课，教授日语入门内容。五十音图及日语词汇用中文讲解，逐步引入日语表达。 | The directive correctly identifies Chinese as the teaching language and reasonably explains the introduction of Japanese content, aligning with the requirement for a beginner Japanese course. |
| 7 | Japanese user wants English teaching | PASS | 5 | Teach Python in English. The student is a native Japanese speaker, so provide Japanese translations for difficult concepts. Keep programming terms in English. | The directive correctly identifies English as the teaching language and appropriately addresses the needs of a native Japanese speaker by including Japanese translations for difficult concepts while keeping programming terms in English. |
| 8 | Chinese user with English PDF | PASS | 4 | 用中文授课。论文的专有名词和技术术语将在原文中保留英文，以便学生对照理解。 | The directive uses the correct primary teaching language (Chinese) and reasonably handles terminology by retaining English terms for clarity, which aligns with the requirement. |
| 9 | English user with Chinese PDF | PASS | 4 | Teach in English. The course will explain the concepts presented in the paper, retaining technical terms in English while providing concise explanations. | The directive correctly specifies English as the teaching language and reasonably addresses the retention of technical terms in English while providing explanations, aligning with the requirement. |
| 10 | Chinese technical course (React hooks) | PASS | 5 | 用中文授课。React、useState 和 useEffect 等术语保留英文原文，首次出现时附简短中文解释。 | The directive correctly specifies Chinese as the teaching language and appropriately retains English terms while providing brief Chinese explanations, aligning well with the requirement. |
| 11 | Chinese course on machine learning | PASS | 4 | 用中文授课，教授机器学习的基础概念。专业术语如监督学习、非监督学习等保留英文原文，并附中文解释。 | The directive correctly uses Chinese as the teaching language and appropriately retains technical terms in English while providing Chinese explanations, aligning well with the requirement. |
| 12 | Mixed Chinese-English requirement | PASS | 7 | 用中文授课。编程术语如 Next.js、React 等保留英文原文，并附上简短中文解释以便理解。 | The directive uses the correct primary teaching language (Chinese) and appropriately handles technical terminology by retaining English terms while providing brief Chinese explanations. |
| 13 | Extremely short requirement (Chinese) | PASS | 4 | 用中文授课，讲解光合作用的基本概念和过程。生物学术语使用中文标准译名。 | The directive correctly specifies Chinese as the teaching language and appropriately addresses the use of standard Chinese translations for biological terms, aligning well with the requirement. |
| 14 | Extremely short requirement (English) + English locale | PASS | 5 | Teach in English. Keep scientific terms like 'photosynthesis', 'chlorophyll', and 'stomata' in English while providing clear explanations. | The directive correctly specifies English as the teaching language and appropriately handles scientific terminology by keeping key terms in English while ensuring clear explanations are provided. |
| 15 | Ambiguous requirement + Chinese user bio | PASS | 4 | 用中文授课。生物学术语使用中文标准译名，如'光合作用''叶绿体''气孔'等。 | The directive correctly specifies the teaching language as Chinese and appropriately uses standard Chinese translations for biological terms, aligning with the user requirement. |
| 16 | Ambiguous requirement + Japanese browser locale | PASS | 4 | 日本語で授業を行います。Machine Learning、Algorithm、Dataなどの技術用語は英語のまま使用し、初出時に日本語の説明を付けます。 | The directive correctly identifies Japanese as the teaching language and appropriately retains technical terms in English while providing Japanese explanations, aligning with the requirement. |
| 17 | Chinese user with Japanese PDF | PASS | 3 | 用中文授课。文献原文为日文，专业术语首次出现时保留日文原文并附中文翻译，方便学生对照理解。 | The directive correctly identifies Chinese as the teaching language and appropriately handles the Japanese terminology by providing both the original Japanese terms and their Chinese translations for better understanding. |
