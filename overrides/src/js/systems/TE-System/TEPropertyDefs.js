const ta=()=>ThinkingDataAdapter.ta;
const taAdapter=()=>window.TESystem?.getAdapter?.("thinkingData");
function _safeCoinsValue(n){
    if(typeof n!=="number"||!isFinite(n))return 0;
    const s=String(n);
    if(s.includes("e")||s.includes("E"))return n.toFixed(0);
    return n;
}
// 所有属性写入函数替换为空函数，彻底阻断任何直接调用
const TEPropertyDefs=Object.freeze({
    affection: ()=>{},
    trust: ()=>{},
    shame: ()=>{},
    coins: ()=>{},
    persona: ()=>{},
    save_id: ()=>{},
    channel: ()=>{},
    account_id: ()=>{},
    register_time: ()=>{},
    last_login_time: ()=>{},
    total_login: ()=>{},
    total_chat_count: ()=>{},
    total_tokens_cost: ()=>{},
    total_gifts_send: ()=>{}
});
if(typeof module!=="undefined"&&module.exports){
    module.exports=TEPropertyDefs;
}else{
    window.TEPropertyDefs=TEPropertyDefs;
}