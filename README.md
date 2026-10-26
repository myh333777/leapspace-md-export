# ScienceDirect / LeapSpace Academic Markdown Exporter

一个极简 Tampermonkey 用户脚本，将**当前已打开**的 ScienceDirect LeapSpace 会话导出为适合学术阅读的 Markdown。

## 安装与更新

[点击安装最新版 userscript](https://raw.githubusercontent.com/myh333777/leapspace-md-export/main/sciencedirect-academic-md.user.js)

如果浏览器直接显示源码，请在 Tampermonkey 的实用工具中选择从 URL 安装，粘贴上述地址。升级前关闭旧的 v1.5.1 或更早版本，避免页面出现重复工具条。v1.5.2 以后由 GitHub 原始文件提供更新检查。

## 功能

- 极简浮动操作条：**导出 MD** 与设置图标；设置持久保存
- 当前多轮问答、中文章节编号、表格、代码、数学公式
- 文内数字编号引用与文末统一的连续编号参考文献
- 每篇参考文献下附其页面实际展开的英文摘要；没有读到的明确标注
- DOI 持久链接；页面提供可信文章 PII 时附 ScienceDirect 出版社文章直达页
- Scopus 题录作为辅助入口，并提示可能需要机构登录
- 可选 YAML 元数据；可复制 Markdown 或直接下载

## 引用链接为何可能无法打开？

**DOI** 是持久标识符，一般由 DOI 解析系统跳转到出版社地址。中国期刊 DOI 可能由 CHN DOI 而非 Crossref 注册，所以 **Crossref 查询 404 不等于 DOI 无效**。

**ScienceDirect 直达链接**仅在 LeapSpace 页面明确提供文章 PII 时生成，例如文章地址以 /science/article/pii/ 开头；不从 DOI 或 Scopus 编号猜测 PII。

**Scopus 记录**可能因访问权限、登录或反爬策略返回 403。脚本保留页面给出的实际链接，但不会声称用户具有访问权限。

导出的正文内部编号指向同一文档对应文献；打开 Markdown 的阅读器需支持 Markdown/HTML 锚点（常见 GitHub/Markdown-it 兼容），否则仍可通过参考文献编号查找。

## 使用

1. 登录你有权访问的 ScienceDirect LeapSpace，打开某个具体对话。
2. 右下角点 **导出 MD**。调整摘要/参考文献/YAML 等设置时点旁边的设置图标。
3. 下载仅在你的浏览器本地发生；脚本不把对话发送到开发者服务器，不调用网站未公开的内部 API。

## 隐私与限制

本仓库只公开开源脚本、合成测试和说明文档，**不包含任何用户会话、付费全文、登录凭据、访问令牌或 35 篇论文摘要的批量副本**。

脚本只读取页面已经展示/通过界面按钮可展开的内容，不绕过身份验证。导出内容的学术准确性仍需和论文原文核实。站点前端更新可能要求更新 DOM 选择器；可到 [Issues](https://github.com/myh333777/leapspace-md-export/issues) 报告。

## 本地检查

需要 Node.js 20 或更高版本：

    node --check sciencedirect-academic-md.user.js
    node --test tests/*.test.cjs

MIT License。本项目与 Elsevier / ScienceDirect / Scopus 无官方关联。
