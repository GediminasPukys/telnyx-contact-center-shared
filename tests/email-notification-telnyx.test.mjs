import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTelnyxNotificationEmail, emailNotificationProvider, parseEmailFrom } from '../lib/email-config.mjs';

test('notification provider defaults to Mailgun and switches only on EMAIL_PROVIDER=telnyx',()=>{
  assert.equal(emailNotificationProvider({}),'mailgun');
  assert.equal(emailNotificationProvider({EMAIL_PROVIDER:' Telnyx '}),'telnyx');
  assert.equal(emailNotificationProvider({EMAIL_PROVIDER:'ses'}),'mailgun');
});

test('EMAIL_FROM is split into address and display name',()=>{
  assert.deepEqual(parseEmailFrom('"NFQ CC <noreply@cc.example.com>"'),{address:'noreply@cc.example.com',name:'NFQ CC'});
  assert.deepEqual(parseEmailFrom('"Support Team" <a@b.co>'),{address:'a@b.co',name:'Support Team'});
  assert.deepEqual(parseEmailFrom('noreply@cc.example.com'),{address:'noreply@cc.example.com',name:''});
});

test('Telnyx payload carries bodies, sender name and inline parts addressed by filename',()=>{
  const payload=buildTelnyxNotificationEmail({from:'NFQ CC <noreply@cc.example.com>',to:'x@nfq.com',subject:'Hi',html:'<img src="cid:qr.png">',text:'Hi',
    inlineAttachments:[{data:Buffer.from('png'),filename:'qr.png',contentType:'image/png',contentId:'qr'},{filename:'empty.png'}]});
  assert.deepEqual(payload,{from:'noreply@cc.example.com',from_name:'NFQ CC',to:['x@nfq.com'],subject:'Hi',html_body:'<img src="cid:qr.png">',text_body:'Hi',
    attachments:[{filename:'qr.png',content:Buffer.from('png').toString('base64'),content_type:'image/png',content_id:'qr.png',disposition:'inline'}]});
  const plain=buildTelnyxNotificationEmail({from:'a@b.co',to:'x@nfq.com',subject:'S',html:'<p>S</p>'});
  assert.equal(plain.from_name,undefined);assert.equal(plain.text_body,undefined);assert.equal(plain.attachments,undefined);
});
