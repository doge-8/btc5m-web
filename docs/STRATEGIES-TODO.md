Currently, after one strategy finishes executing, the subsequent strategies are not executed; optimize to place multiple orders

bestBid/bestAsk is sometimes fetched inaccurately; use the REST API to periodically calibrate the WS, fetching once every 5 seconds, and reconnect this WS after 3 consecutive readings exceed the threshold

Do a code review and optimize the code

Build a backend-only version for deployment on a cloud server


Crash bug to reproduce (observed that every time memory fills up, the Binance line lags on the time axis, but the data trend is real-time; only the overall line becomes laggy, and the yellow dots also drift toward the left of the x-axis; after switching the time window, memory is released again)
<--- Last few GCs --->

[57571:0x748400000]   855007 ms: Mark-Compact 3998.8 (4144.0) -> 3998.8 (4144.0) MB, pooled: 0 MB, 29.54 / 0.00 ms  (average mu = 0.384, current mu = 0.086) allocation failure; scavenge might not succeed
[57571:0x748400000]   855051 ms: Mark-Compact 3999.0 (4144.2) -> 3998.9 (4144.2) MB, pooled: 0 MB, 40.33 / 0.00 ms  (average mu = 0.242, current mu = 0.072) allocation failure; scavenge might not succeed


<--- JS stacktrace --->

FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
----- Native stack trace -----

 1: 0x1006039c0 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 2: 0x1007dae90 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 3: 0x100a044cc v8::internal::Heap::stack() [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 4: 0x100a0272c v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 5: 0x1009f83c0 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 6: 0x1009f8d8c v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 7: 0x1009cb68c v8::internal::FactoryBase<v8::internal::Factory>::NewRawOneByteString(int, v8::internal::AllocationType) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 8: 0x1009cb4c8 v8::internal::FactoryBase<v8::internal::Factory>::NewStringFromOneByte(v8::base::Vector<unsigned char const>, v8::internal::AllocationType) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
 9: 0x100b0dee0 v8::internal::JsonStringifier::Stringify(v8::internal::Handle<v8::internal::Object>, v8::internal::Handle<v8::internal::Object>, v8::internal::Handle<v8::internal::Object>) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
10: 0x100b0dc50 v8::internal::JsonStringify(v8::internal::Isolate*, v8::internal::Handle<v8::internal::Object>, v8::internal::Handle<v8::internal::Object>, v8::internal::Handle<v8::internal::Object>) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
11: 0x100850114 v8::internal::Builtin_JsonStringify(int, unsigned long*, v8::internal::Isolate*) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
12: 0x1014bb914 Builtins_CEntry_Return1_ArgvOnStack_BuiltinExit [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
13: 0x10bfcf98c 
14: 0x10bf3ea20 
15: 0x10c082408 
16: 0x10c0808cc 
17: 0x10bfacaf4 
18: 0x10c12b3d0 
19: 0x10c0a9a44 
20: 0x10bfd4390 
21: 0x10c173f18 
22: 0x10c0b03ec 
23: 0x10bf8f344 
24: 0x10c09eed0 
25: 0x10bea3fc4 
26: 0x10142250c Builtins_JSEntryTrampoline [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
27: 0x1014221b0 Builtins_JSEntry [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
28: 0x100957ebc v8::internal::(anonymous namespace)::Invoke(v8::internal::Isolate*, v8::internal::(anonymous namespace)::InvokeParams const&) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
29: 0x10095781c v8::internal::Execution::Call(v8::internal::Isolate*, v8::internal::Handle<v8::internal::Object>, v8::internal::Handle<v8::internal::Object>, int, v8::internal::Handle<v8::internal::Object>*) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
30: 0x1007f2930 v8::Function::Call(v8::Isolate*, v8::Local<v8::Context>, v8::Local<v8::Value>, int, v8::Local<v8::Value>*) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
31: 0x100505cec node::InternalMakeCallback(node::Environment*, v8::Local<v8::Object>, v8::Local<v8::Object>, v8::Local<v8::Function>, int, v8::Local<v8::Value>*, node::async_context, v8::Local<v8::Value>) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
32: 0x10051b1cc node::AsyncWrap::MakeCallback(v8::Local<v8::Function>, int, v8::Local<v8::Value>*) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
33: 0x1007324b0 node::StreamBase::CallJSOnreadMethod(long, v8::Local<v8::ArrayBuffer>, unsigned long, node::StreamBase::StreamBaseJSChecks) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
34: 0x100733c48 node::EmitToJSStreamListener::OnStreamRead(long, uv_buf_t const&) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
35: 0x1007b4c34 node::crypto::TLSWrap::ClearOut() [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
36: 0x1007b6b98 node::crypto::TLSWrap::OnStreamRead(long, uv_buf_t const&) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
37: 0x100738080 node::LibuvStreamWrap::OnUvRead(long, uv_buf_t const*) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
38: 0x1007387c8 node::LibuvStreamWrap::ReadStart()::$_1::__invoke(uv_stream_s*, long, uv_buf_t const*) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
39: 0x10140c8c4 uv__stream_io [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
40: 0x101414edc uv__io_poll [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
41: 0x101401850 uv_run [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
42: 0x100506508 node::SpinEventLoopInternal(node::Environment*) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
43: 0x10064d250 node::NodeMainInstance::Run() [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
44: 0x1005bf5f4 node::Start(int, char**) [/Users/yuepin/.nvm/versions/node/v23.11.0/bin/node]
45: 0x186b79d54 start [/usr/lib/dyld]