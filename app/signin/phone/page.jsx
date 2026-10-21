import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { redirect } from "next/navigation";
import PhoneSelection from "@/components/telephony/PhoneSelection";
import AuthPageLayout from "@/components/auth-page-layout";
export default async function PhoneSelectionPage() {
  if (!(await getServerSession(authOptions))?.user) redirect("/signin");
  return <AuthPageLayout contentClassName="mt-12 max-w-md"><PhoneSelection /></AuthPageLayout>;
}
