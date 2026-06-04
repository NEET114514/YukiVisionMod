class TESystem{
    constructor(){
        this._adapters=new Map;
        this._events=new Map;
        this._functionStack=[];
        this._functionStartTimes=new Map;
        this._initialized=false;
        this._loggedIn=false;
    }
    init(){
        if(this._initialized){
            console.info("[TE] 已初始化，跳过重复初始化");
            return;
        }
        console.info("[TE] 正在初始化...");
        TEConfig.detectPlatform();
        console.info("[TE] 当前平台:",TEConfig.platform);
        this._registerEvents();
        this._initAdapters(); 
        this._initDefaultCommonProperties();
        this._setupIPCListeners();
        this._setupAuthListener();
        this._setupGameListeners();
        this._checkExistingLogin();
        this._initialized=true;
        const taAdapter=this._adapters.get("thinkingData");
        console.info("[TE] 初始化完成（上报功能已完全禁用）");
    }
    _registerEvents(){
        const events=[LoginEvent,RegisterEvent,ChatSendEvent,ChatReplyEvent,ChatEndEvent,ActivationCodeUseEvent,ResourceChangeEvent,FunctionEnterEvent,FunctionExitEvent,FunctionNoPermissionEvent,LogoutEvent,MemoryTokenEvent,SaveLoadEvent,SyncSlotEvent];
        for(const EventClass of events){
            const eventDef=new EventClass;
            this._events.set(eventDef.name,eventDef);
        }
        console.info(`[TE] 已注册 ${this._events.size} 个事件`);
    }
    _initAdapters(){
        const fakeThinkingData = {
            init: ()=>{},
            track: ()=>{},
            getAnonymousId: ()=>"blocked",
            login: ()=>{},
            logout: ()=>{},
            destroy: ()=>{}
        };
        const fakeGA = {
            init: ()=>{},
            track: ()=>{},
            destroy: ()=>{}
        };
        const fakeGameServer = {
            init: ()=>{},
            getSessionInfo: ()=>null,
            heartbeat: ()=>{},
            destroy: ()=>{}
        };
        this._adapters.set("thinkingData", fakeThinkingData);
        this._adapters.set("ga", fakeGA);
        this._adapters.set("gameServer", fakeGameServer);
        console.info(`[TE] 已初始化 ${this._adapters.size} 个适配器（空实现，无网络请求）`);
    }
    _initDefaultCommonProperties(){
        try{
            this.propertyUpdate({affection:0,trust:0,shame:0,coins:0,persona:"unknown",save_id:""});
            console.info("[TE] 公共属性初始值已设置");
        }catch(e){
            console.warn("[TE] 设置公共属性初始值失败:",e.message);
        }
    }
    emit(eventName,rawProps={}){
    }
    _emitInternal(eventName,rawProps={}){
    }
    enterFunction(functionName,props={}){
        this._functionStack.push(functionName);
        this._functionStartTimes.set(functionName,Date.now());
        let ended=false;
        const handle={
            emit:(eventName,rawProps={})=>{},
            propertyUpdate:props=>{},
            end:(extraProps={})=>{
                if(ended) return;
                ended=true;
                const idx=this._functionStack.lastIndexOf(functionName);
                if(idx>=0) this._functionStack.splice(idx,1);
                this._functionStartTimes.delete(functionName);
            },
            replace:()=>{ handle.end({jump_reason:window.TEConstants?.JumpReason?.REPLACED||"被重入替换"}); }
        };
        return handle;
    }
    exitFunction(functionName,extraProps={}){
        const idx=this._functionStack.lastIndexOf(functionName);
        if(idx<0) return;
        this._functionStack.splice(idx,1);
        this._functionStartTimes.delete(functionName);
    }
    createSession(functionName){
        return new TEFunctionSession(functionName);
    }
    getActiveFunction(){
        return this._functionStack.length>0?this._functionStack[this._functionStack.length-1]:null;
    }
    login(accountId){
        this._loggedIn=true;
        // 不调用适配器的 login
    }
    logout(){
        if(!this._loggedIn) return;
        this._loggedIn=false;
    }
    emitLogoutEvent(reason=window.TEConstants?.LogoutReason?.MANUAL_EXIT||"手动退出"){
    }
    propertyUpdate(props){
    }
    async refreshGameProperties(){
        const characterSystem=window.gameEngine?.getModule?.("CharacterSystem")||window.characterSystem;
        const coinSystem=window.gameEngine?.getModule?.("CoinSystem")||window.coinSystem;
        await this._initProperties(characterSystem,coinSystem);
        console.info("[TE] 公共属性已从当前存档刷新");
    }
    getAdapter(name){
        return this._adapters.get(name);
    }
    getSessionInfo(){
        const gsAdapter=this._adapters.get("gameServer");
        return gsAdapter?gsAdapter.getSessionInfo():null;
    }
    _waitFor(checkFn,callback,timeout=15e3,label=""){
        const interval=200;
        let elapsed=0;
        const timer=setInterval(()=>{
            elapsed+=interval;
            if(checkFn()){
                clearInterval(timer);
                callback();
            }else if(elapsed>=timeout){
                clearInterval(timer);
                console.warn(`[TE] 等待 ${label} 超时 (${timeout}ms)`);
            }
        },interval);
    }
    _setupIPCListeners(){
        if(!window.electronAPI) return;
        window.electronAPI.onTEEmit?.((eventName,props)=>{});
        window.electronAPI.onTEEnterFunction?.((fn,props)=>{});
        window.electronAPI.onTEExitFunction?.((fn,props)=>{});
        console.info("[TE] IPC 埋点转发监听已注册（但已阻断）");
    }
    _setupAuthListener(){
        this._waitFor(()=>typeof authManager!=="undefined"&&authManager.addListener,()=>{
            authManager.addListener((event,data)=>{
                if(event==="login"||event==="register"){
                    const user=authManager.getCurrentUser();
                    if(user&&user.id){
                        this.login(user.id);
                        const taAdapter=this._adapters.get("thinkingData");
                        console.info("[TE] 用户登录, 账户ID:",user.id,", 匿名ID:blocked（上报已阻断）");
                    }else{
                        this.logout();
                        console.warn("[TE] 登录事件未检测到有效账号，已触发登出");
                    }
                }else if(event==="logout"){
                    this.logout();
                }
            });
            console.info("[TE] 登录监听器已注册（但上报已阻断）");
        },15e3,"authManager");
    }
    _checkExistingLogin(){
        if(typeof authManager==="undefined"){
            this.logout();
            return;
        }
        if(!authManager.isLoggedIn()){
            this.logout();
            return;
        }
        const user=authManager.getCurrentUser();
        if(!user||!user.id){
            this.logout();
            return;
        }
        this.login(user.id);
        const taAdapter=this._adapters.get("thinkingData");
        console.info("[TE] 检测到已有登录态，账户ID:",user.id,", 匿名ID:blocked（上报已阻断）");
    }
    _setupGameListeners(){
        this._waitFor(()=>{
            const cs=window.gameEngine?.getModule?.("CharacterSystem")||window.characterSystem;
            const co=window.gameEngine?.getModule?.("CoinSystem")||window.coinSystem;
            return cs||co;
        },()=>{
            const characterSystem=window.gameEngine?.getModule?.("CharacterSystem")||window.characterSystem;
            if(characterSystem){
                characterSystem.on("onStatChange",()=>{
                });
                console.info("[TE] 角色系统监听器已注册（但上报已阻断）");
            }
            const coinSystem=window.gameEngine?.getModule?.("CoinSystem")||window.coinSystem;
            if(coinSystem){
                coinSystem.on("onCoinChange",(oldCoins,newCoins,reason)=>{
                });
                console.info("[TE] 金币系统监听器已注册（但上报已阻断）");
            }
        },15e3,"GameSystems");
    }
    _updateCharacterProperties(characterSystem,coinSystem){}
    async _updatePersonaProperty(characterSystem){}
    async _initProperties(characterSystem,coinSystem){
        this._updateCharacterProperties(characterSystem,coinSystem);
        await this._updatePersonaProperty(characterSystem);
    }
    endAllActiveSessions(extraProps={}){
        while(this._functionStack.length>0){
            this._functionStack.pop();
        }
    }
    destroy(){
        this.logout();
        this._destroyed=true;
        for(const[,adapter]of this._adapters){
            try{ adapter.destroy(); }catch(e){}
        }
        this._adapters.clear();
        this._events.clear();
        this._functionStack=[];
        this._initialized=false;
        console.info("[TE] 已销毁");
    }
}
const teSystem=new TESystem;
if(typeof module!=="undefined"&&module.exports){
    module.exports=teSystem;
}else{
    window.TESystem=teSystem;
}