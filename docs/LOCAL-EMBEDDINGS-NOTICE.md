# 本地中文向量模型

- 模型：北京智源人工智能研究院 BGE-small-zh-v1.5，512 维，CLS 池化后 L2 归一化。
- 上游说明：https://huggingface.co/BAAI/bge-small-zh-v1.5
- ONNX 转换：Xenova，https://huggingface.co/Xenova/bge-small-zh-v1.5
- 固定版本：`75c43b069aac4d136ba6bc1122f995fedcfd2781`，`onnx/model_quantized.onnx`，q8。
- 上游模型声明 MIT 许可。模型资产按需下载，不提交到源码仓库；已下载缓存约 23 MB。首次下载需要访问 Hugging Face 的模型分发服务，查询和知识文本不会发送给该站点。
- 推理依赖 `@huggingface/transformers`（Apache-2.0）与 ONNX Runtime（MIT）；依赖保留其原许可文件。

知识片段在当前工作空间 SQLite 中保存向量；模型权重缓存可复用，但不会复用其他工作空间的文本、向量或查询结果。模型缓存后可离线检索；GPT 对话仍需要网络。

相似度只是召回信号，不是正确率。本地默认门槛 0.40，可在模型设置调整。应使用自身业务的正、负样本校准；不得把少量合成验收当成大规模质量保证。

## 上游模型许可

MIT License

Copyright (c) 2022 staoxiao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
