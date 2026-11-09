import React, { createContext, useContext, useState } from 'react';
const OWNER = {id:'75a865e4-4abc-4a16-b48f-63a7b0c1e665',email:'matiss.frasne@gmail.com',email_confirmed_at:'2026-10-01T00:00:00.000Z'};
function auth(kind) {
 if(kind==='anonymous') return {user:null,session:null,loading:false};
 if(kind==='loading') return {user:null,session:null,loading:true};
 const user=kind==='stranger'?{...OWNER,id:'b439f6b9-e123-4ed0-ae20-32943ae05ed8',email:'stranger@example.test'}:kind==='unverified'?{...OWNER,email_confirmed_at:null}:OWNER;
 return {user,session:{access_token:'isolated-test-session-'+kind},loading:false};
}
const Context=createContext(auth('anonymous'));
export function TestAuthProvider({children}) {
 const [state,setState]=useState(()=>auth(new URLSearchParams(location.search).get('auth')||'owner'));
 window.__setAuth=(kind)=>setState(auth(kind));
 return <Context.Provider value={state}>{children}</Context.Provider>;
}
export function useAuth(){return useContext(Context);}
