"use client";

import type { ReactNode } from "react";
import NfcProvider from "./NfcProvider";
import NfcReadDialog from "./NfcReadDialog";
import ToastProvider from "./Toast";
import ConfirmProvider from "./ConfirmDialog";
import ThemeProvider from "./ThemeProvider";
import UpdateBanner from "./UpdateBanner";
import { TranslationProvider } from "@/i18n/TranslationProvider";

export default function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <TranslationProvider>
        <ToastProvider>
          {/* GH #343 (#1): in-app confirm replaces native window.confirm() —
              themed, asynchronous, and doesn't freeze the renderer. */}
          <ConfirmProvider>
            <NfcProvider>
              <UpdateBanner />
              {children}
              <NfcReadDialog />
            </NfcProvider>
          </ConfirmProvider>
        </ToastProvider>
      </TranslationProvider>
    </ThemeProvider>
  );
}
