'use client';
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { useUiText } from '@/components/i18n/use-ui-text';
export default function DesktopSignIn({id,code,email}) {
  const tUi=useUiText(),[busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
  async function approve(){setBusy(true);setError('');try{
    const response=await fetch('/api/auth/desktop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'approve',id})});
    const data=await response.json();if(!response.ok)throw Error(data.error);setDone(true);
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">{tUi('Sign in to Contact Center Desktop')}</h1>
    {!code?<p role="alert">{tUi('This sign-in request expired. Start again in the desktop app.')}</p>:done?<p role="status">{tUi('Sign-in confirmed. Return to the desktop app; you can close this tab.')}</p>:<>
      <p className="text-sm text-muted-foreground">{tUi('Only continue if you started sign-in in your desktop app and the code below matches.')}</p>
      <p className="rounded-xl border p-4 text-center font-mono text-2xl tracking-widest">{code}</p>
      {email?<><p className="text-sm">{email}</p><Button disabled={busy} onClick={approve}>{tUi('Continue to desktop app')}</Button></>:<Button disabled={busy} onClick={()=>{setBusy(true);signIn('google',{callbackUrl:`/signin/desktop?request=${id}`});}}>{tUi('Continue with Google')}</Button>}
      {error?<p role="alert" className="text-sm text-destructive">{tUi(error)}</p>:null}
    </>}
  </div>;
}
