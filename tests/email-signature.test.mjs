import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentEmail, emailSignature } from '../lib/email/policy.mjs';

const mailbox={address:'support@example.com',name:'Support',sending_enabled:true};
const original={provider_message_id:'inbound-id',rfc_message_id:'root@example.com',envelope:{from:'customer@example.com',to:['support@example.com'],cc:[]}};
const reply=extra=>({mode:'reply',to:'customer@example.com',subject:'Re: Help',text:'Thank you',...extra});

test('no configured signature leaves the outbound email unchanged',()=>{
  assert.equal(emailSignature(null,{agentName:'Ann Agent',mailbox}),null);
  assert.equal(emailSignature({text:'  ',from_name:''},{mailbox}),null);
  const {payload,draft}=buildAgentEmail({draft:reply({html:'<p>Thank you</p>'}),mailbox,original,signature:null});
  assert.equal(payload.text_body,'Thank you');assert.equal(payload.html_body,'<p>Thank you</p>');assert.equal(payload.from_name,undefined);
  assert.equal(draft.text,'Thank you');
});

test('signature placeholders render and are appended to text, HTML and the stored draft',()=>{
  const signature=emailSignature({text:'Kind regards,\r\n{{agent_name}}\n{{mailbox_name}} <{{mailbox_address}}>\n{{unknown}}',from_name:'NFQ "Support"'},{agentName:'Ann <Agent>',mailbox});
  assert.equal(signature.text,'Kind regards,\nAnn <Agent>\nSupport <support@example.com>\n{{unknown}}');
  assert.equal(signature.fromName,'NFQ Support');
  assert.equal(signature.html,'<div data-cc-signature="">Kind regards,<br>Ann &lt;Agent&gt;<br>Support &lt;support@example.com&gt;<br>{{unknown}}</div>');
  const {payload,draft}=buildAgentEmail({draft:reply({text:'Thank you\n\n',html:'<p>Thank you</p>'}),mailbox,original,signature});
  assert.equal(payload.text_body,`Thank you\n\n${signature.text}`);
  assert.equal(payload.html_body,`<p>Thank you</p><br>${signature.html}`);
  assert.equal(payload.from_name,'NFQ Support');assert.equal(payload.from,'support@example.com');
  assert.equal(draft.text,payload.text_body);assert.equal(draft.html,payload.html_body);
});

test('HTML documents get the signature inside the last body and empty parts stay empty',()=>{
  const signature=emailSignature({text:'Regards'},{mailbox});
  const {payload}=buildAgentEmail({draft:reply({text:'',html:'<html><body><p>Hi</p></body></html>'}),mailbox,original,signature});
  assert.equal(payload.html_body,'<html><body><p>Hi</p><br><div data-cc-signature="">Regards</div></body></html>');
  assert.equal(payload.text_body,'');assert.equal(payload.from_name,undefined);
});
