"""认证：登录、当前用户"""
import bcrypt
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel


class LoginIn(BaseModel):
    username: str
    password: str = ""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..db.models import User, UserRole

router = APIRouter(prefix="/auth", tags=["auth"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

ALGORITHM = "HS256"
ACCESS_EXPIRE_MINUTES = 60 * 24 * 7


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str = "student"


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    display_name: str | None
    student_no: str | None
    avatar_url: str | None

    class Config:
        from_attributes = True


class ProfileUpdateIn(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


def create_token(user_id: int, role: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_EXPIRE_MINUTES)
    payload = {"sub": str(user_id), "role": role, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


async def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        user_id = int(payload.get("sub", 0))
    except (JWTError, ValueError):
        return None
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()


async def require_teacher(user: User | None = Depends(get_current_user)) -> User:
    if not user or user.role not in (UserRole.teacher.value, UserRole.admin.value):
        raise HTTPException(status_code=403, detail="需要教师权限")
    return user


async def require_admin(user: User | None = Depends(get_current_user)) -> User:
    if not user or user.role != UserRole.admin.value:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


@router.post("/login", response_model=Token)
async def login(form: LoginIn, db: AsyncSession = Depends(get_db)):
    # 演示：任意用户名+密码；teacher/teacher 为教师，其余为学生
    username = (form.username or "").strip()
    password = form.password or ""
    if not username:
        raise HTTPException(status_code=400, detail="请输入用户名")
    result = await db.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if not user:
        # 演示用：自动创建用户
        raw = (password or "123456").encode()
        hashed = bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")
        role = UserRole.admin.value if username == "admin" else (UserRole.teacher.value if username == "teacher" else UserRole.student.value)
        user = User(
            username=username,
            hashed_password=hashed,
            role=role,
            display_name=username,
            student_no=username if role == UserRole.teacher.value else None,
        )
        db.add(user)
        await db.flush()
    else:
        hashed_bytes = user.hashed_password.encode() if isinstance(user.hashed_password, str) else user.hashed_password
        if not bcrypt.checkpw(password.encode(), hashed_bytes):
            raise HTTPException(status_code=401, detail="密码错误")
    await db.commit()
    token = create_token(user.id, user.role)
    return Token(access_token=token, role=user.role)


@router.get("/me", response_model=UserOut | None)
async def me(user: User | None = Depends(get_current_user)):
    if not user:
        return None
    return UserOut(
        id=user.id,
        username=user.username,
        role=user.role,
        display_name=user.display_name,
        student_no=user.student_no,
        avatar_url=user.avatar_url,
    )


@router.put("/profile", response_model=UserOut)
async def update_profile(payload: ProfileUpdateIn, user: User | None = Depends(get_current_user)):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")

    if payload.display_name is not None:
        display_name = payload.display_name.strip()
        if len(display_name) > 64:
            raise HTTPException(status_code=400, detail="显示姓名长度不能超过 64")
        user.display_name = display_name or None

    if payload.avatar_url is not None:
        avatar = payload.avatar_url.strip()
        if len(avatar) > 2_800_000:
            raise HTTPException(status_code=400, detail="头像内容过大，请上传不超过 1.5MB 的图片")
        user.avatar_url = avatar or None

    return UserOut(
        id=user.id,
        username=user.username,
        role=user.role,
        display_name=user.display_name,
        student_no=user.student_no,
        avatar_url=user.avatar_url,
    )


@router.post("/password")
async def change_password(payload: PasswordChangeIn, user: User | None = Depends(get_current_user)):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    if not payload.new_password or len(payload.new_password) < 6:
        raise HTTPException(status_code=400, detail="新密码长度至少 6 位")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="新密码不能与旧密码相同")

    hashed_bytes = user.hashed_password.encode() if isinstance(user.hashed_password, str) else user.hashed_password
    if not bcrypt.checkpw(payload.current_password.encode(), hashed_bytes):
        raise HTTPException(status_code=401, detail="当前密码错误")

    user.hashed_password = bcrypt.hashpw(payload.new_password.encode(), bcrypt.gensalt()).decode("utf-8")
    return {"ok": True}
