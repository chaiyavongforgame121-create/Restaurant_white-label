'use client';

// The few words the shared components print themselves (a sheet's Close button, a dialog's
// Cancel, the chat thread, the offline banner), in every interface language.
//
// Deliberately not next-intl: this package would have to depend on it and every render outside a
// provider (tests, a new root) would throw. The apps already know the active language, so each
// root layout passes it to <UiLocaleProvider>; anything rendered without one gets English.

import * as React from 'react';
import { DEFAULT_UI_LOCALE, type UiLocale } from '@favornoms/shared';

export interface UiStrings {
  /** Label of the language picker. */
  language: string;
  close: string;
  cancel: string;
  save: string;
  ok: string;
  confirm: string;

  /** QuantityStepper buttons (screen-reader names). */
  decrease: string;
  increase: string;

  /** ConnectionBanner. */
  offlineBanner: string;
  backOnline: string;

  /** ChatThread. */
  chatClosed: string;
  chatPlaceholder: string;
  chatEmpty: string;
  chatSending: string;
  chatNotSent: string;
  chatSend: string;
  chatTakePhoto: string;
  chatChoosePhoto: string;
  /** Alt text of a photo-only message. */
  chatPhotoAlt: string;
  /** Alt text of a photo still uploading. */
  chatPhotoSendingAlt: string;
  /** Accessible name of the full-screen photo viewer. */
  chatPhotoViewer: string;
  chatClosePhoto: string;

  /** DietaryBadge. */
  dietaryVegan: string;
  dietaryHalal: string;
  dietarySpicy: string;
  dietaryGlutenFree: string;
  dietaryNew: string;
  dietaryChefPick: string;
}

const EN: UiStrings = {
  language: 'Language',
  close: 'Close',
  cancel: 'Cancel',
  save: 'Save',
  ok: 'OK',
  confirm: 'Confirm',

  decrease: 'Decrease',
  increase: 'Increase',

  offlineBanner: "You're offline — viewing cached data",
  backOnline: 'Back online',

  chatClosed: 'This conversation is closed.',
  chatPlaceholder: 'Type a message…',
  chatEmpty: 'No messages yet — say hi 👋',
  chatSending: 'Sending…',
  chatNotSent: 'Not sent — tap to retry',
  chatSend: 'Send',
  chatTakePhoto: 'Take a photo',
  chatChoosePhoto: 'Choose a photo',
  chatPhotoAlt: 'Photo in the conversation',
  chatPhotoSendingAlt: 'Photo being sent',
  chatPhotoViewer: 'Photo',
  chatClosePhoto: 'Close photo',

  dietaryVegan: 'Vegan',
  dietaryHalal: 'Halal',
  dietarySpicy: 'Spicy',
  dietaryGlutenFree: 'GF',
  dietaryNew: 'New',
  dietaryChefPick: "Chef's Pick",
};

export const UI_STRINGS: Record<UiLocale, UiStrings> = {
  en: EN,
  es: {
    language: 'Idioma',
    close: 'Cerrar',
    cancel: 'Cancelar',
    save: 'Guardar',
    ok: 'Aceptar',
    confirm: 'Confirmar',

    decrease: 'Disminuir',
    increase: 'Aumentar',

    offlineBanner: 'Sin conexión: estás viendo datos guardados',
    backOnline: 'Conexión restablecida',

    chatClosed: 'Esta conversación está cerrada.',
    chatPlaceholder: 'Escribe un mensaje…',
    chatEmpty: 'Aún no hay mensajes. ¡Saluda! 👋',
    chatSending: 'Enviando…',
    chatNotSent: 'No se envió: toca para reintentar',
    chatSend: 'Enviar',
    chatTakePhoto: 'Tomar una foto',
    chatChoosePhoto: 'Elegir una foto',
    chatPhotoAlt: 'Foto de la conversación',
    chatPhotoSendingAlt: 'Enviando foto',
    chatPhotoViewer: 'Foto',
    chatClosePhoto: 'Cerrar foto',

    dietaryVegan: 'Vegano',
    dietaryHalal: 'Halal',
    dietarySpicy: 'Picante',
    dietaryGlutenFree: 'Sin gluten',
    dietaryNew: 'Nuevo',
    dietaryChefPick: 'Favorito del chef',
  },
  vi: {
    language: 'Ngôn ngữ',
    close: 'Đóng',
    cancel: 'Hủy',
    save: 'Lưu',
    ok: 'OK',
    confirm: 'Xác nhận',

    decrease: 'Giảm',
    increase: 'Tăng',

    offlineBanner: 'Mất kết nối — đang xem dữ liệu đã lưu',
    backOnline: 'Đã kết nối lại',

    chatClosed: 'Cuộc trò chuyện này đã đóng.',
    chatPlaceholder: 'Nhập tin nhắn…',
    chatEmpty: 'Chưa có tin nhắn — gửi lời chào nhé 👋',
    chatSending: 'Đang gửi…',
    chatNotSent: 'Chưa gửi được — chạm để thử lại',
    chatSend: 'Gửi',
    chatTakePhoto: 'Chụp ảnh',
    chatChoosePhoto: 'Chọn ảnh',
    chatPhotoAlt: 'Ảnh trong cuộc trò chuyện',
    chatPhotoSendingAlt: 'Ảnh đang được gửi',
    chatPhotoViewer: 'Ảnh',
    chatClosePhoto: 'Đóng ảnh',

    dietaryVegan: 'Thuần chay',
    dietaryHalal: 'Halal',
    dietarySpicy: 'Cay',
    dietaryGlutenFree: 'Không gluten',
    dietaryNew: 'Mới',
    dietaryChefPick: 'Đầu bếp gợi ý',
  },
  th: {
    language: 'ภาษา',
    close: 'ปิด',
    cancel: 'ยกเลิก',
    save: 'บันทึก',
    ok: 'ตกลง',
    confirm: 'ยืนยัน',

    decrease: 'ลดจำนวน',
    increase: 'เพิ่มจำนวน',

    offlineBanner: 'ออฟไลน์อยู่ — กำลังแสดงข้อมูลที่บันทึกไว้',
    backOnline: 'กลับมาออนไลน์แล้ว',

    chatClosed: 'การสนทนานี้ปิดแล้ว',
    chatPlaceholder: 'พิมพ์ข้อความ…',
    chatEmpty: 'ยังไม่มีข้อความ — ทักทายกันเลย 👋',
    chatSending: 'กำลังส่ง…',
    chatNotSent: 'ส่งไม่สำเร็จ — แตะเพื่อลองอีกครั้ง',
    chatSend: 'ส่ง',
    chatTakePhoto: 'ถ่ายรูป',
    chatChoosePhoto: 'เลือกรูป',
    chatPhotoAlt: 'รูปภาพในการสนทนา',
    chatPhotoSendingAlt: 'รูปภาพที่กำลังส่ง',
    chatPhotoViewer: 'รูปภาพ',
    chatClosePhoto: 'ปิดรูปภาพ',

    dietaryVegan: 'วีแกน',
    dietaryHalal: 'ฮาลาล',
    dietarySpicy: 'เผ็ด',
    dietaryGlutenFree: 'ไม่มีกลูเตน',
    dietaryNew: 'ใหม่',
    dietaryChefPick: 'เชฟแนะนำ',
  },
};

const UiLocaleContext = React.createContext<UiLocale>(DEFAULT_UI_LOCALE);

export function UiLocaleProvider({ locale, children }: { locale: UiLocale; children: React.ReactNode }) {
  return <UiLocaleContext.Provider value={locale}>{children}</UiLocaleContext.Provider>;
}

export function useUiLocale(): UiLocale {
  return React.useContext(UiLocaleContext);
}

/** The active language's strings, with English behind any that are missing. */
export function useUiStrings(): UiStrings {
  const locale = React.useContext(UiLocaleContext);
  return React.useMemo(() => ({ ...EN, ...UI_STRINGS[locale] }), [locale]);
}
