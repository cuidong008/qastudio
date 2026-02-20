import { useEffect, useState } from "react";
import { APP_TOAST_EVENT, ToastTone } from "../utils/toast";

type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastPayload = {
  message: string;
  tone?: ToastTone;
};

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = (id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  useEffect(() => {
    const onToast = (event: Event) => {
      const customEvent = event as CustomEvent<ToastPayload>;
      const detail = customEvent.detail;
      if (!detail?.message) return;
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const tone = detail.tone || "info";
      setItems((prev) => [...prev, { id, message: detail.message, tone }].slice(-4));
    };

    window.addEventListener(APP_TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(APP_TOAST_EVENT, onToast);
    };
  }, []);

  return (
    <div className="toast-host" aria-live="polite" aria-atomic="true">
      {items.map((item) => (
        <div key={item.id} className={`toast-item toast-${item.tone}`}>
          <div className="toast-content">{item.message}</div>
          <button type="button" className="toast-close" onClick={() => remove(item.id)} aria-label="关闭消息">
            关闭
          </button>
        </div>
      ))}
    </div>
  );
}
