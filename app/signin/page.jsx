
import { LoginForm } from "@/components/login-form";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { redirect } from "next/navigation";
import AuthPageLayout from "@/components/auth-page-layout";
import { cookies } from "next/headers";

export default async function SigninPage({ searchParams }) {
  const params = await searchParams;
  if (params?.error) {
    const active = (await cookies()).get('cc-desktop-active')?.value;
    if (/^[a-f0-9]{48}$/.test(active || '')) redirect(`/api/auth/desktop/browser?request=${active}&error=cancelled`);
  }
  const session = await getServerSession(authOptions);
  if (session?.user) redirect("/signin/phone");

  if (params?.username || params?.password) {
    const cleanParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "username" || key === "password") continue;
      if (Array.isArray(value)) {
        value.forEach((item) => cleanParams.append(key, item));
      } else if (value != null) {
        cleanParams.set(key, value);
      }
    }
    const query = cleanParams.toString();
    redirect(query ? `/signin?${query}` : "/signin");
  }

  return <AuthPageLayout><LoginForm /></AuthPageLayout>;
}
