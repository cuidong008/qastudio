# 《计算机网络基础》课程智能体 · QAStudio

面向应用型大学经管学院电子商务专业的课程专属、场景化、轻量化教学辅助智能体，覆盖课前预习、课中辅助、课后复习、习题训练全流程，并提供教师端学情监控与配置。

## 项目结构

- **backend/**：FastAPI 后端（数据层、能力层、API）
- **frontend/**：Vite + React 前端（学生端 + 教师端同一应用，按角色路由）

## 快速开始

### 环境要求

- Python 3.10+
- Node.js 18+

### 文档转换依赖（可选，按操作系统）

用于以下能力：
- `soffice`：PPTX 转 PDF
- `pdftoppm`：PDF 转图片

#### macOS

```bash
brew install --cask libreoffice
brew install poppler
```

#### Linux

```bash
# Debian/Ubuntu
sudo apt update
sudo apt install -y libreoffice poppler-utils

# Fedora/RHEL/CentOS（使用 dnf）
sudo dnf install -y libreoffice poppler-utils
```

#### Windows

```powershell
# 使用 winget
winget install -e --id TheDocumentFoundation.LibreOffice
winget install -e --id oschwartz10612.Poppler
```

安装后可验证：

```bash
soffice --version
pdftoppm -v
```

### 后端

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # Linux/macOS
pip install -r requirements.txt
cp .env.example .env     # 可选，按需修改
python -m app.db.seed    # 初始化数据库与种子数据
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 前端

```bash
cd frontend
npm install
npm run dev
```

浏览器访问：http://localhost:5173

- **学生端**：用户名 `student`，密码 `student`（登录后进入四大入口：预习 / 课中 / 复习 / 习题）
- **教师端**：用户名 `teacher`，密码 `teacher`（学情概览、配置、导出 CSV）
- **后管台**：用户名 `admin`，密码 `admin`（用户/班级/课程/开课分配管理；**RAG 配置**可在「RAG 配置」页通过表单填写，无需改 .env）

### API 文档

后端启动后访问：http://localhost:8000/docs

## 架构概览

- **学生端**：课前预习（任务生成、薄弱点反馈）、课中辅助（实时答疑、PPT 定位）、课后复习（知识框架、答疑）、习题训练（分层推送、错题本）
- **教师端**：教学内容配置、学情数据监控（预习完成率、提问汇总、正确率、薄弱点）、教学决策支持、数据导出；可按课程上传 PPT（`POST /api/ppt/upload`）
- **后管台**：用户管理（创建/编辑用户、角色、班级分配）、班级管理、课程管理（含章节）、开课分配（课程开给哪些班级、指定授课教师）
- **后台支撑**：多课程（Course）、开课（Teaching）、课程知识库、智能问答引擎（当前为占位，可接入 RAG）、习题题库、学习行为数据、权限与安全

## 后续扩展（已澄清约束）

- **自研 RAG**：已实现模块化 RAG（`backend/app/rag/`），与业务解耦；LLM 可配置 vLLM / 阿里千问 / 智谱，Embedding 可配置程序自带或外部 API，向量库为单机 Chroma。详见 [RAG配置说明](docs/RAG配置说明.md)。启用后需先为课程建索引：`POST /api/admin/courses/{id}/reindex`。
- PPT 以备注文字为主做理解与关联，先实现在线预览到某一页
- 课中响应不要求 1–2 秒实时，5 秒内未完成 PPT 跳转则停止；单课堂按 60–80 人并发设计
- 公网部署、优先支持纯移动端浏览器（可有 App）；暂不接入学校统一身份认证
- 多班级/多学期，区分班级、学期、授课教师；产品内建反馈入口，支持问卷与对话收集反馈
- 学习数据（答题记录、错题、提问内容）保存 6 个月，标识匿名化；内容由教师审核，新内容不需先审后发
