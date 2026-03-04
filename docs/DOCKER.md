# QAStudio Docker 编译与部署说明

本项目使用**单容器**部署：在镜像构建时编译前端，将产物放入后端 `static` 目录，由 FastAPI 统一托管前后端，对外只暴露一个端口（8000）。

## 一、前置要求

- Docker（建议 20.10+）
- Docker Compose（建议 v2+，或 `docker compose` 插件）

## 二、构建与运行

### 2.1 使用 Docker Compose（推荐）

在项目根目录执行：

```bash
# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f app
```

- **访问地址**：浏览器打开 `http://localhost:8000`
- **API 文档**：`http://localhost:8000/docs`
- 数据（SQLite、上传文件、RAG 向量库等）持久化在 Docker 卷 `qastudio_data` 中。

### 2.2 仅使用 Docker

```bash
# 构建镜像
docker build -t qastudio:latest .

# 运行（需挂载数据目录）
docker run -d --name qastudio \
  -p 8000:8000 \
  -v qastudio_data:/data \
  -e SECRET_KEY=your-production-secret \
  qastudio:latest
```

## 三、镜像构建说明

- **多阶段构建**：
  - **阶段一**：使用 `node:20-alpine` 安装依赖并执行 `npm run build`，前端 API 基地址在构建时设为 `/api`（与后端同源）。
  - **阶段二**：使用 `python:3.12-slim` 安装后端依赖，将阶段一生成的 `frontend/dist` 拷贝到后端的 `static` 目录，最终由 uvicorn 启动 FastAPI。
- 运行时通过环境变量将数据库、上传目录、RAG 向量库等指向容器内 `/data`，再通过卷挂载实现持久化。

## 四、环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `APP_NAME` | 应用名称 | 计算机网络基础课程智能体 |
| `DEBUG` | 调试模式 | false |
| `DATABASE_URL` | 数据库连接（默认 SQLite） | sqlite+aiosqlite:////data/qastudio.db |
| `SECRET_KEY` | 认证密钥（生产必改） | change-me-in-production |
| `CORS_ORIGINS` | 跨域来源（同源部署可设为 *） | * |
| `UPLOAD_DIR` | 上传文件目录 | /data/uploads |
| `RAG_VECTOR_STORE_PATH` | RAG 向量库路径 | /data/rag_vector_store |

更多配置见 `backend/.env.example`，可在 `docker-compose.yml` 的 `environment` 中按需添加。

## 五、数据持久化

- `docker-compose.yml` 中已配置卷 `qastudio_data` 挂载到容器内 `/data`。
- 以下内容会保存在该卷中：
  - SQLite 数据库：`/data/qastudio.db`
  - 上传文件：`/data/uploads`
  - RAG 向量库：`/data/rag_vector_store`

备份时可直接备份该卷或宿主机上的卷挂载目录。

## 六、常用命令

```bash
# 停止并删除容器（卷保留）
docker compose down

# 停止并删除容器及卷（会清空数据）
docker compose down -v

# 仅重新构建镜像
docker compose build --no-cache

# 进入容器
docker compose exec app bash
```

## 七、本地开发说明

- 本地开发时仍可分别启动前端（Vite，如 5173）和后端（uvicorn，如 8000），无需使用 Docker。
- 后端只有在存在 `backend/static/index.html`（即已构建前端并放入 `static`）时才会托管前端；否则根路径返回 JSON，便于本地前后端分离开发。
