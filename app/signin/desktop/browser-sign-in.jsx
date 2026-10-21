'use client';
import { useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { Loader2 } from 'lucide-react';
import { useUiText } from '@/components/i18n/use-ui-text';

export default function BrowserSignIn({id,valid}) {
  const tUi = useUiText(), started = useRef(false);
  const [failed,setFailed] = useState(!valid);
  useEffect(() => {
    if (!valid || started.current) return;
    started.current = true;
    async function begin() {
      try {
        const response = await fetch('/api/auth/desktop/browser', {
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'begin',id}),
        });
        if (!response.ok) throw Error('Sign-in unavailable');
        await signIn('google',{callbackUrl:`/api/auth/desktop/browser?request=${id}`},{prompt:'select_account'});
      } catch { setFailed(true); }
    }
    void begin();
  },[id,valid]);
  return <div className="space-y-5">
    <h1 className="text-2xl font-semibold">{tUi('Sign in to Contact Center Desktop')}</h1>
    {failed ? <p role="alert">{tUi('This sign-in request expired. Start again in the desktop app.')}</p> :
      <p role="status" className="flex items-center gap-3"><Loader2 className="size-5 animate-spin" aria-hidden="true"/>{tUi('Opening Google sign-in. You will return to the desktop app automatically.')}</p>}
  </div>;
}
