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
        console.info("[TE] 初始化完成, 匿名ID:",taAdapter?.getAnonymousId()||"未获取");
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
        const taAdapter=new ThinkingDataAdapter;
        taAdapter.init(TEConfig.thinkingData);
        this._adapters.set("thinkingData",taAdapter);
        const gaAdapter=new GAAdapter;
        gaAdapter.init(TEConfig.ga);
        this._adapters.set("ga",gaAdapter);
        const gsAdapter=new GameServerAdapter;
        gsAdapter.init(TEConfig.gameServer,TEConfig.platform);
        this._adapters.set("gameServer",gsAdapter);
        console.info(`[TE] 已初始化 ${this._adapters.size} 个适配器`);
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
        const activeFunction=this.getActiveFunction();
        if(activeFunction){
            rawProps={_activeFunction:activeFunction,...rawProps};
        }
        this._emitInternal(eventName,rawProps);
    }
    // ========== 阻断所有内部事件发送 ==========
    _emitInternal(eventName,rawProps={}){
        // 完全阻断，不调用任何适配器的 track 方法
        return;
    }
    enterFunction(functionName,props={}){
        const sourcePage=this.getActiveFunction()||window.TEConstants.SourcePage.MAIN;
        // 注意：这里原本会 emit("function_enter")，但 _emitInternal 已阻断，所以不会发送
        this._functionStack.push(functionName);
        this._functionStartTimes.set(functionName,Date.now());
        const startTime=Date.now();
        const boundCode=props.bound_code||"";
        let ended=false;
        const handle={
            emit:(eventName,rawProps={})=>{
                if(ended){
                    console.warn(`[TE] 过期 session (${functionName}) 仍在发事件: ${eventName}`);
                }
                // 阻断所有通过 handle 发送的事件
                // rawProps={_activeFunction:functionName,...rawProps};
                // this._emitInternal(eventName,rawProps);
            },
            propertyUpdate:props=>{
                if(ended){
                    console.warn(`[TE] 过期 session (${functionName}) 仍在更新属性`);
                }
                // 阻断属性更新
                // this.propertyUpdate(props);
            },
            end:(extraProps={})=>{
                if(ended) return;
                ended=true;
                const idx=this._functionStack.lastIndexOf(functionName);
                if(idx>=0) this._functionStack.splice(idx,1);
                this._functionStartTimes.delete(functionName);
                // 阻断 function_exit 事件
                // this.emit("function_exit",{...});
            },
            replace:()=>{
                handle.end({jump_reason:window.TEConstants?.JumpReason?.REPLACED||"被重入替换"});
            }
        };
        return handle;
    }
    exitFunction(functionName,extraProps={}){
        const idx=this._functionStack.lastIndexOf(functionName);
        if(idx<0) return;
        this._functionStack.splice(idx,1);
        this._functionStartTimes.delete(functionName);
        // 阻断 function_exit 事件发送
        // this.emit("function_exit",{...});
    }
    createSession(functionName){
        return new TEFunctionSession(functionName);
    }
    getActiveFunction(){
        return this._functionStack.length>0?this._functionStack[this._functionStack.length-1]:null;
    }
    // 阻断登录上报（保留本地登录状态）
    login(accountId){
        this._loggedIn=true;
        // 不调用适配器的 login
    }
    // 阻断登出上报
    logout(){
        if(!this._loggedIn) return;
        this._loggedIn=false;
        // 不调用适配器的 logout
    }
    emitLogoutEvent(reason=window.TEConstants?.LogoutReason?.MANUAL_EXIT||"手动退出"){
        if(!this._loggedIn) return;
        const user=typeof authManager!=="undefined"?authManager.getCurrentUser():null;
        // 阻断 logout 事件发送
        // this.emit("logout",{...});
    }
    // 阻断公共属性写入
    propertyUpdate(props){
        // 完全阻断，不调用 TEPropertyDefs
        return;
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
        // 保留监听但回调中不再发送事件
        window.electronAPI.onTEEmit?.((eventName,props)=>{
            // 阻断：不再调用 this.emit
        });
        window.electronAPI.onTEEnterFunction?.((fn,props)=>{
            // 阻断：不再调用 this.enterFunction
        });
        window.electronAPI.onTEExitFunction?.((fn,props)=>{
            // 阻断：不再调用 this.exitFunction
        });
        console.info("[TE] IPC 埋点转发监听已注册（但已阻断）");
    }
    _setupAuthListener(){
        this._waitFor(()=>typeof authManager!=="undefined"&&authManager.addListener,()=>{
            authManager.addListener((event,data)=>{
                if(event==="login"||event==="register"){
                    const user=authManager.getCurrentUser();
                    if(user&&user.id){
                        this.login(user.id);
                        // 阻断属性更新
                        // this.propertyUpdate({...});
                        // 阻断 register / login 事件
                        // this.emit("register",{...});
                        // this.emit("login",{...});
                        const taAdapter=this._adapters.get("thinkingData");
                        console.info("[TE] 用户登录, 账户ID:",user.id,", 匿名ID:",taAdapter?.getAnonymousId()||"未获取（但上报已阻断）");
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
        // 阻断属性更新
        // this.propertyUpdate({...});
        // 阻断 login 事件
        // this.emit("login",{...});
        const taAdapter=this._adapters.get("thinkingData");
        console.info("[TE] 检测到已有登录态，立即上报, 账户ID:",user.id,", 匿名ID:",taAdapter?.getAnonymousId()||"未获取（但上报已阻断）");
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
                    // 阻断属性更新（原本会调用 this.propertyUpdate）
                    // 此处不做任何操作
                });
                console.info("[TE] 角色系统监听器已注册（但上报已阻断）");
            }
            const coinSystem=window.gameEngine?.getModule?.("CoinSystem")||window.coinSystem;
            if(coinSystem){
                coinSystem.on("onCoinChange",(oldCoins,newCoins,reason)=>{
                    // 阻断资源变化事件
                    // this.propertyUpdate({coins:newCoins});
                    // this.emit("resource_change",{...});
                });
                console.info("[TE] 金币系统监听器已注册（但上报已阻断）");
            }
        },15e3,"GameSystems");
    }
    _updateCharacterProperties(characterSystem,coinSystem){
        // 原本会调用 propertyUpdate，现已被阻断，所以函数体可空
    }
    async _updatePersonaProperty(characterSystem){
        // 原本会调用 propertyUpdate，现已被阻断
    }
    async _initProperties(characterSystem,coinSystem){
        this._updateCharacterProperties(characterSystem,coinSystem);
        await this._updatePersonaProperty(characterSystem);
    }
    endAllActiveSessions(extraProps={}){
        while(this._functionStack.length>0){
            const functionName=this._functionStack[this._functionStack.length-1];
            // 阻断 function_exit 事件
            // this.emit("function_exit",{function_name:functionName,...extraProps});
            this._functionStack.pop();
        }
    }
    destroy(){
        this.logout();
        this._destroyed=true;
        for(const[,adapter]of this._adapters){
            try{
                adapter.destroy();
            }catch(e){}
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