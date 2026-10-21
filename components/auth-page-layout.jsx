import { UiText } from "@/components/i18n/use-ui-text";
import { AuthBrandLogo } from "@/components/auth-brand-logo";
import { AuthRightImage } from "@/components/auth-right-image";
import { cn } from "@/lib/utils";

export default function AuthPageLayout({ children, contentClassName = "mt-30 max-w-xs" }) {
  return <div className="dark grid min-h-svh bg-background text-foreground lg:grid-cols-[1fr_1.8fr]">
    <div className="flex min-w-0 flex-col gap-4 p-6 md:p-10">
      <div className="flex w-full flex-col items-center justify-center"><AuthBrandLogo /><span className="mt-10 text-center text-4xl font-bold text-brand-primary xl:text-6xl"><UiText>Contact Center</UiText></span></div>
      <div className="flex flex-1 justify-center"><div className={cn("w-full", contentClassName)}>{children}</div></div>
    </div>
    <div className="relative m-5 hidden overflow-hidden rounded-xl bg-muted lg:block"><AuthRightImage /></div>
  </div>;
}
