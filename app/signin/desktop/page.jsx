import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { inspectDesktopAuth } from '@/lib/desktop-auth.mjs';
import { inspectBrowserAuth } from '@/lib/desktop-browser-auth.mjs';
import AuthPageLayout from '@/components/auth-page-layout';
import DesktopSignIn from './sign-in';
import BrowserSignIn from './browser-sign-in';
export default async function DesktopSignInPage({searchParams}) {
  const params=await searchParams, id=params.request;
  if (params.flow === 'browser') {
    const valid = await inspectBrowserAuth(getPostgresPool(),id);
    return <AuthPageLayout><BrowserSignIn id={id} valid={valid}/></AuthPageLayout>;
  }
  const flow=await inspectDesktopAuth(getPostgresPool(),id);
  const session=await getServerSession(authOptions);
  return <AuthPageLayout><DesktopSignIn id={id} code={flow?.code} email={session?.user?.email}/></AuthPageLayout>;
}
