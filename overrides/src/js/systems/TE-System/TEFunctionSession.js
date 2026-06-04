class TEFunctionSession{
    constructor(functionName,parent=null,transport=null){
        this._functionName=functionName;
        this._parent=parent;
        this._transport=transport;
        this._handle=null;
        this._isRemoteActive=false;
        this._children=[];
        this._partId=null;
    }
    get _isRemote(){ return this._transport!==null; }
    setPartId(partId){ this._partId=partId; }
    get rootFunctionName(){
        let current=this;
        while(current._parent) current=current._parent;
        return current._functionName;
    }
    get parentFunctionName(){ return this._parent?._functionName||null; }
    child(childFunctionName){
        const childSession=new TEFunctionSession(childFunctionName,this,this._transport);
        this._children.push(childSession);
        return childSession;
    }
    fail(failReason,extraProps={}){
        // 完全阻断 fail 上报
        // 原逻辑会调用 transport.emit 或 TESystem.emit，现在什么都不做
    }
    start(props={}){
        if(this._partId){
            props={part_id:this._partId,...props};
        }
        if(this._isRemote){
            this._isRemoteActive=true;
            // 阻断远程的 enterFunction 调用
            // this._transport.enterFunction(this._functionName,props);
        }else{
            if(this._handle){
                this._handle.replace();
            }
            // 阻断本地 handle（TESystem.enterFunction 返回的对象）
            // 但仍然需要模拟一个 handle 对象，以保证后续 emit/end 等调用不报错
            if(window.TESystem){
                // 创建一个假的 handle，让后续调用不报错，但不实际进入 function 栈
                // 但为了保持 function 栈状态，我们仍然调用真实的 enterFunction 吗？
                // 不，那样会产生 function_enter 事件。为了完全阻断，不能调用真实的 enterFunction。
                // 而是构造一个假的 handle，其 emit/end/propertyUpdate 为空操作。
                this._handle = {
                    emit: ()=>{},
                    end: ()=>{},
                    propertyUpdate: ()=>{},
                    replace: ()=>{}
                };
            }else{
                this._handle = null;
            }
        }
        return this;
    }
    emit(eventName,rawProps={}){
        if(this._partId){
            rawProps={_partId:this._partId,...rawProps};
        }
        if(this._parent){
            rawProps={_parentFunction:this.rootFunctionName,...rawProps};
        }
        if(this._isRemote){
            // 阻断远程发送
            // rawProps={_activeFunction:this._functionName,...rawProps};
            // this._transport.emit(eventName,rawProps);
        }else if(this._handle){
            // 阻断本地 handle 的 emit
            // this._handle.emit(eventName,rawProps);
        }else{
            // 阻断直接调用 window.TESystem.emit
            // window.TESystem?.emit(eventName,rawProps);
        }
    }
    end(extraProps={}){
        for(const child of this._children){
            child.end();
        }
        this._children=[];
        if(this._partId){
            extraProps={part_id:this._partId,...extraProps};
        }
        if(this._isRemote){
            if(this._isRemoteActive){
                // 阻断远程 exitFunction
                // this._transport.exitFunction(this._functionName,extraProps);
                this._isRemoteActive=false;
            }
        }else if(this._handle){
            // 阻断本地 handle 的 end
            // this._handle.end(extraProps);
            this._handle=null;
        }
    }
    propertyUpdate(props){
        // 阻断任何属性更新上报
        // if(this._isRemote){
        //     // 远程处理
        // }else if(this._handle){
        //     this._handle.propertyUpdate(props);
        // }else{
        //     window.TESystem?.propertyUpdate(props);
        // }
    }
    get isActive(){
        return this._isRemote ? this._isRemoteActive : this._handle!==null;
    }
}
window.TEFunctionSession=TEFunctionSession;