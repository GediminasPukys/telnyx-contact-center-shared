"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { notify } from "@/components/ToastNotify";
import { signIn } from "next-auth/react";
import { useAuth } from "@/components/auth-provider";

import { IconBrandGoogleFilled } from "@tabler/icons-react";

const subscribeToHydration = () => () => {};
const clientReadySnapshot = () => true;
const serverReadySnapshot = () => false;

export function LoginForm({ className, ...props }) {
  const tUi = useUiText();
  const clientReady = useSyncExternalStore(subscribeToHydration, clientReadySnapshot, serverReadySnapshot);
  const [submitting, setSubmitting] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const handledRef = useRef(false);
  const { refresh } = useAuth();
  const [desktopStatus, setDesktopStatus] = useState("");
  const [desktopCode, setDesktopCode] = useState(""); // Older installed clients.

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const sensitiveParams = ["password", "username"];
      const hadSensitiveParams = sensitiveParams.some((param) =>
        url.searchParams.has(param)
      );

      if (hadSensitiveParams) {
        sensitiveParams.forEach((param) => url.searchParams.delete(param));
        const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState(null, "", cleanUrl || "/signin");
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!error) return;
    console.log("[LOGIN] Error:", error);
    notify({
      title: "Login failed",
      description: error === "CredentialsSignin" ? "Invalid credentials" : error,
      variant: "error",
      autoCloseMs: 2000,
    });
  }, [error]);

  async function onSubmit(e) {
    console.log("[LOGIN] Submitting...");
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData(e.currentTarget);
      const username = (form.get("username") || "").toString();
      const password = (form.get("password") || "").toString();
      const res = await signIn("credentials", {
        username,
        password,
        callbackUrl: "/signin/phone",
        redirect: false,
      });
      console.log("[LOGIN] Response:", res);
      if (res?.error) {
        handledRef.current = false;
        console.log("[LOGIN] Error:", res.error);
        setError(res.error || "Invalid credentials");
      } else if (res?.ok) {
        handledRef.current = true;
        notify({
          title: "Authentication successful",
          description: "You have been logged in successfully.",
          variant: "success",
          autoCloseMs: 3000,
        });
        try {
          localStorage.removeItem("nav-main.selected");
        } catch (_) {}
        try {
          refresh?.();
        } catch (_) {}
        // Keep the session on this origin (a local Electron deployment may
        // have a different public OAuth callback URL behind its tunnel).
        window.location.replace("/signin/phone");
      } else {
        setError("Invalid credentials");
      }
    } catch (err) {
      console.error("[LOGIN] Exception:", err);
      setError("Failed to sign in");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      data-testid="signin-form"
      data-client-ready={clientReady}
      className={cn("flex flex-col gap-6", className)}
      method="post"
      onSubmit={onSubmit}
      {...props}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">{tUi("Sign in to your account")}</h1>
        <p className="text-muted-foreground text-sm text-balance">{tUi("Enter your email below to login to your account")}</p>
      </div>
      <div className="grid gap-6">
        <div className="grid gap-3">
          <Label htmlFor="username">{tUi("Email")}</Label>
          <Input
            id="username"
            name="username"
            type="email"
            placeholder={tUi("your email address")}
            autoComplete="username"
            required
          />
        </div>
        <div className="grid gap-3">
          <div className="flex items-center">
            <Label htmlFor="password">{tUi("Password")}</Label>
            <a
              href="/forgot-password"
              className="ml-auto text-sm underline-offset-4 hover:underline"
            >{tUi("Forgot your password?")}</a>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder={tUi("your password")}
            autoComplete="current-password"
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={!clientReady || submitting}>
          {submitting ? tUi("Logging in...") : tUi("Login")}
        </Button>
        <div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
          <span className="bg-background text-muted-foreground relative z-10 px-2">{tUi("Or")}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={submitting || oauthSubmitting}
          onClick={async (e) => {
            e.preventDefault();
            if (submitting || oauthSubmitting) return;
            setOauthSubmitting(true);
            try {
              localStorage.removeItem("nav-main.selected");
            } catch (_) {}
            if (window.contactCenterDesktop?.signInGoogle) {
              const desktop = window.contactCenterDesktop;
              const unsubscribe = desktop.onSignInStatus?.(setDesktopStatus) || desktop.onSignInCode?.(setDesktopCode) || (() => {});
              setDesktopStatus("browser");
              setError(null);
              try {
                const result = await desktop.signInGoogle();
                if (result?.ok === false) {
                  if (result.error !== "cancelled") setError(result.error === "expired" ? "Sign-in expired. Try again." : "Desktop sign-in was not completed. Try again.");
                } else if (!desktop.onSignInStatus) window.location.replace("/signin/phone");
              }
              catch { setError("Desktop sign-in was not completed. Try again."); }
              finally { unsubscribe(); setDesktopCode(""); setDesktopStatus(""); setOauthSubmitting(false); }
            } else signIn("google", { callbackUrl: "/signin/phone" });
          }}
        >
          <IconBrandGoogleFilled className="mr-2 h-5 w-5" aria-hidden="true" />{tUi("Continue with Google")}</Button>
      </div>
      {desktopCode ? <p role="status" className="rounded-lg border p-3 text-center text-sm">{tUi("Complete sign-in in your browser. Confirm this code:")} <strong className="font-mono">{desktopCode}</strong></p> : null}
      {desktopStatus && !desktopCode ? <div className="rounded-lg border p-3 text-center text-sm space-y-3">
        <p role="status">{desktopStatus === "completing" ? tUi("Completing sign-in...") : tUi("Continue in your browser. This app will open automatically after sign-in.")}</p>
        <Button type="button" variant="outline" onClick={() => window.contactCenterDesktop.cancelSignIn?.()}>{tUi("Cancel")}</Button>
      </div> : null}
      <div className="text-center text-sm">{tUi("Don't have an account?")}{" "}
        <a href="/signup" className="underline underline-offset-4">{tUi("Sign up")}</a>
      </div>
    </form>
  );
}
