for(const action of ['retry','settings'])document.getElementById(action).addEventListener('click',async()=>{
  const button=document.getElementById(action);button.disabled=true;
  try{await window.contactCenterDesktop.recoverConnection(action);}finally{button.disabled=false;}
});
