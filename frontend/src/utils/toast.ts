export type ToastTone = "info" | "success" | "error";

type ToastPayload = {
  message: string;
  tone?: ToastTone;
};

export const APP_TOAST_EVENT = "app:toast";

export function toast(message: string, tone: ToastTone = "info") {
  window.dispatchEvent(
    new CustomEvent<ToastPayload>(APP_TOAST_EVENT, {
      detail: { message, tone },
    })
  );
}
