# 多视频口播分段重排 — JSON 字段说明

## status
任务分析状态。
- `success` = 已完成分析并生成可执行分段。
程序可据此判断是否继续执行裁剪。

## audio_policy
全局音频规则。

### audio_policy.keep_source_audio
默认是否保留源视频原声。
- `true` = 保留。

### audio_policy.audio_moves_with_video
分段重新排序时，音频是否必须跟随对应视频片段一起移动。
必须为 `true`。

### audio_policy.same_time_range
音频和画面是否使用完全相同的源视频起止时间。
必须为 `true`。

### audio_policy.audio_edge_fade_ms
后续实际裁剪时，对每段音频首尾增加的极短淡入淡出时长，单位毫秒。
主要用于避免硬切产生点击声或爆音。
建议 5–30ms。
不能因此改变视频裁剪时间。

## sources
全部原始视频列表。

### sources[].source_id
原视频内部唯一编号。
例如：A、B、C
后续 segments 通过 source_id 指向具体源视频。

### sources[].filename
原始视频文件名。

### sources[].duration
源视频真实时长，单位秒。

### sources[].has_audio
源视频是否存在音轨。
- `true` = 有音轨。
- `false` = 无音轨。

### sources[].speech_present
该视频中是否检测到人物口播。

### sources[].speech_timeline
该原视频完整的口播时间轴。
这是分析阶段识别出的口播，不等于最终裁剪分段。

#### speech_timeline[].start
该句或该完整语言单元在源视频中的开始时间，单位秒。

#### speech_timeline[].end
该句或该完整语言单元在源视频中的结束时间，单位秒。

#### speech_timeline[].text
识别出的真实口播原文。
保持原语言，不翻译、不润色。

## segments
后续程序真正用于裁剪的分段列表。
这是最核心的数据。

### segments[].segment_id
每个分段的唯一 ID。
建议格式：`A_S01`、`A_S02`、`B_S01`
其中 A = source_id，S01 = 该来源的分段编号

### segments[].source_id
该分段来自哪个原视频。
必须对应 sources 中已存在的 source_id。

### segments[].start
该分段在源视频中的开始时间，单位秒。

### segments[].end
该分段在源视频中的结束时间，单位秒。
程序实际执行时应从对应 source_id 的视频中裁剪 start → end，视频和音频使用相同时间范围。

### segments[].product_id
该分段展示的产品编号。
例如：P1、P2、P3
用于避免不同款式之间发生错误归属。
无法确认两个视频是否属于同款时，应使用不同 product_id。

### segments[].content
该分段的内容摘要。
需要表达：这段在讲什么 + 画面在展示什么。
例如：`"正面展示睡裙，同时介绍胸前蕾丝和面料柔软度"`
这个字段主要用于排序逻辑和人工排查，不直接控制 FFmpeg。

### segments[].speech_text
该分段实际包含的口播文字。
无讲话时：`"speech_text": ""`
有讲话时必须对应该分段 start/end 范围内的真实口播。

### segments[].speech_complete
该分段中的口播是否完整。
- `true` 表示没有剪断完整的一句话或完整语义单元。
- `false` 表示存在不完整口播。
原则上 speech_complete=false 的分段不得进入 final_sequence。

### segments[].safe_start
该分段起点是否为安全切点。
`true` 表示已经综合检查：口播边界、气口、音频波形、动作、画面状态。
原则上 final_sequence 中使用的分段应为 true。

### segments[].safe_end
该分段终点是否为安全切点。
判断标准与 safe_start 相同。

### segments[].reorderable
该分段是否可以作为独立单元参与全局重新排序。
- `true` 可以自由进入全局排序。
- `false` 不能脱离相关上下文独立移动，通常需要结合 dependency_group 使用。

### segments[].dependency_group
该分段是否属于一个必须维持内部关系的依赖组。
- 无依赖：`null`
- 有依赖：`"G1"`

### segments[].keep_source_audio
该分段是否保留自身对应的原始音频。
默认 `true`。
若为 true，程序必须从同一 source_id 中同时截取视频 start→end 和音频 start→end，不能跨来源配音。

## dependency_groups
保存必须维持内部逻辑顺序的分段组。
如果不存在依赖组，可以输出：`"dependency_groups": []`

### dependency_groups[].group_id
依赖组唯一 ID。例如：G1、G2

### dependency_groups[].segment_ids
属于该依赖组的全部 segment_id。

### dependency_groups[].required_order
依赖组内部必须维持的分段顺序。
例如：`["A_S03", "A_S04", "A_S05"]`
表示无论整个依赖组最终移动到哪里，这三个分段的相对顺序不能改变。

### dependency_groups[].reason
建立依赖关系的原因。
例如：`"肩带调整动作与调整后展示存在明确前后关系"`
主要用于分析和调试。

## final_sequence
最终成片的分段排列顺序。
这是后续程序拼接时最核心的顺序表。

例如：
```json
["B_S02", "A_S03", "C_S01", "A_S01"]
```

程序执行逻辑：
1. 根据 segment_id 找到 segments 中对应对象
2. 根据 source_id 找到源视频
3. 使用 start/end 裁剪对应音画
4. 按 final_sequence 给出的顺序拼接

final_sequence 中不得出现不存在的 segment_id。

## validation
模型在输出 JSON 前执行的逻辑校验结果。

### validation.all_sources_analyzed
是否已经分析全部源视频。

### validation.speech_analyzed_before_segmentation
是否先完成口播分析，再进行视频分段。必须为 true。

### validation.no_sentence_split
是否确认没有把完整一句话剪断。这是重要门禁。

### validation.waveform_and_pause_checked
是否使用了音频波形、气口、停顿辅助判断切点。

### validation.visual_boundary_checked
是否结合画面和动作边界检查切点。

### validation.no_duplicate_ranges
是否没有重复使用同一个源视频时间区间。

### validation.no_overlapping_ranges
同一来源的独立分段是否不存在不必要的时间重叠。

### validation.global_segment_reordering_completed
是否已将无依赖的独立分段放入统一分段池并完成全局重新排序，而不是简单按照原视频顺序输出。

### validation.minimum_six_segments_target_checked
是否检查了"全部视频合计尽量至少形成 6 个可排列分段"的目标。
注意：这不是要求强制达到 6 段。如果安全分段不足 6 个，仍应输出真实可成立的分段，不能剪断讲话、重复或制造重叠区间来凑数。
