# Dhru Fusion Pro 自定义支付网关

GMPay Edge 可作为 Dhru Fusion Pro 的 Custom 网关接口，复用现有订单、收银台、
付款确认和持久化 Webhook 重试机制。协议依据 [Dhru 官方支付网关开发包](https://github.com/dhru-com/payment-gateway-development-kit)。

## 配置

1. 在 GMPay Edge 中配置可用的收款方式和所需法币。首次端到端验证请使用支付渠道沙盒。
2. 创建专用商户 API Key，授予 `orders:create` 和 `orders:read` 权限。在 Dhru Custom
   网关的 API Key 字段填写 `PID.SECRET`，使用创建密钥时显示的 PID 和一次性 Secret。
   请将它仅保存在服务端配置中，不要写进代码或日志。
3. 在 GMPay Edge「设置 → 安全」的「Dhru 回调主机」中，每行填入一个 Dhru 商店的
   精确公网主机名，不含协议、端口或路径。留空时禁止创建 Dhru 订单。创建订单和发送
   通知前都会校验回调 URL 是否为允许的公网 HTTPS 地址。
4. 将 Dhru Custom 网关 POST URL 设为 GMPay 部署根地址，例如
   `https://pay.gsmsky.com/`。GMPay 的「Allowed Hosts」也需允许此部署主机。

Dhru 使用 `X-Api-Key` 调用 `POST /?action=create_order` 和
`GET /?action=get_order&order_id=…`。GMPay 返回其收银台地址，随后由现有支付确认流程
处理付款。浏览器的成功或失败跳转不会改变付款状态。支付渠道通知继续使用 GMPay
原有的渠道专属接口；`/?action=ipn` 不接受付款状态。

同一个 API Key 下，`custom_id`、金额、币种、描述、`ipn_url` 和 `success_url` 完全相同的重复创建
请求会返回同一个 Dhru 订单号；参数冲突会拒绝。Dhru 数字订单号映射到 GMPay 内部
20 位订单号。只有 GMPay 订单为 `paid` 或 `overpaid` 且已确认交易总额达到锁定报价时才报告
`Paid`；未完成的付款保持 `Pending`，终态失败报告 `Failed`。

确认付款后，现有持久化通知队列向保存且列入白名单的 Dhru `ipn_url` 发送
`{"event":{"type":"charge:confirmed","data":{"order_id":123}}}`。Dhru 随后通过
`get_order` 核对金额、币种、`custom_id`、交易 ID 和 `Paid` 状态。失败通知会重试并
记录尝试。在生产使用前，请在沙盒验证实际收款方式、确认时间、Dhru 发票入账和通知重试。
