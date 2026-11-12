# Trustless Gateway 迭代路线

本页仅为系列导航和范围取舍说明；每个 idea 的验收范围由各自 Idea.md 定义，创建或接受前项不等于接受后项。下游 Implementation/Deployment 均只是待细化初版。

## 方法来源

参考 task-engine 在 `f34c54c8e6a727f257fb456ad36817b09a412aa8` 的系列：

- [迭代 1：本地 raw](https://github.com/silvermoon-work/task-engine/blob/f34c54c8e6a727f257fb456ad36817b09a412aa8/.silvermoon/ideas/01M75C5K29RZDCXJEPDRADFAW3/outer/inner/ideal/Idea.md)
- [迭代 2：CAR 路径证明](https://github.com/silvermoon-work/task-engine/blob/f34c54c8e6a727f257fb456ad36817b09a412aa8/.silvermoon/ideas/01M75C8GZ7M5PS1FFWQKW1HRJC/outer/inner/ideal/Idea.md)
- [迭代 3：DAG scope](https://github.com/silvermoon-work/task-engine/blob/f34c54c8e6a727f257fb456ad36817b09a412aa8/.silvermoon/ideas/01M75CA7MBKSAQDFRRKN5PXQ39/outer/inner/ideal/Idea.md)
- [迭代 4：局部读取与协商](https://github.com/silvermoon-work/task-engine/blob/f34c54c8e6a727f257fb456ad36817b09a412aa8/.silvermoon/ideas/01M75CBPP3TFRS1N6K71W1WRYJ/outer/inner/ideal/Idea.md)
- [迭代 5：兼容性与运行保障](https://github.com/silvermoon-work/task-engine/blob/f34c54c8e6a727f257fb456ad36817b09a412aa8/.silvermoon/ideas/01M75CCXR5TWE63N6QEXV1C720/outer/inner/ideal/Idea.md)
- [IPNS 扩展](https://github.com/silvermoon-work/task-engine/blob/f34c54c8e6a727f257fb456ad36817b09a412aa8/.silvermoon/ideas/01M75CFCPV6VNKJRSYPF5VVQ1T/outer/inner/ideal/Idea.md)

沿用小步能力交付、独立证明验证和后置兼容性收口的方法，不照搬本地 Engine 的模块与缓存授权设计。

## Pinboard 系列

| 顺序 | Alias | 构想 | 前置 |
| --- | --- | --- | --- |
| 1 | gateway-01-raw-baseline | [收口 raw 协议与访问边界](Idea.md) | 已有 raw 合规基线 |
| 2 | gateway-02-car-path | [标准 CAR 入口与路径证明](../../../../01M76V81QD1FFYDDGNDX97WA0M/outer/inner/ideal/Idea.md) | 迭代 1 完成 |
| 3 | gateway-03-dag-scopes | [block/entity/all 获取范围](../../../../01M76VAH3G6VKY09Q9060BRMJV/outer/inner/ideal/Idea.md) | 迭代 2 完成 |
| 4 | gateway-04-partial-car | [可验证局部读取与 CAR 协商](../../../../01M76VCG6S8J2DJXX1BTXY3STN/outer/inner/ideal/Idea.md) | 迭代 3 完成 |
| 5 | gateway-05-conformance | [协议兼容性与 Worker 运行保障](../../../../01M76VEYBW0J9Y0E1BB9QRWT50/outer/inner/ideal/Idea.md) | 迭代 4 完成 |
| 6 | gateway-06-ipns-records | [可独立验签的 IPNS 记录](../../../../01M76VHAKEJ4TA4WSNVB4RX769/outer/inner/ideal/Idea.md) | 迭代 5 完成 |

## 与 Pinboard 现状的差异

- raw 已有实现及本地测试，迭代 1 是权限、缓存、浏览器表示与文档一致性收口，不重做单块存储。
- 既有自定义 CAR 导出不是标准 CAR 网关，但其验证与存储能力可以复用；整包快路径不能代替路径证明或选择性读取。
- 现有私有 Pin、Publication、缩略图与 DAG 授权必须保持；本系列不是将所有已存储 blocks 匿名公开。
- 继续使用现有 Worker/D1/R2，遵守现有限额；独立证明验证、官方套件和隔离资源实测分别回答正确性、兼容性与运行保障问题。
- IPNS 是独立扩展，其来源和持久化新鲜度仍需在实施时作出明确决策；不将 Publication 直接映射为 IPNS，不默认新增 DHT。

## 范围声明

以 [Trustless Gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/) 及其引用的 [Path Gateway](https://specs.ipfs.tech/http-gateways/path-gateway/) 为依据，实施时固定上游版本。raw 是 MUST，CAR 和 IPNS record 是 SHOULD，额外 CAR 变体按声明组合支持；不能把可选能力缺失等同于 raw 全部不合规，也不能把 raw 通过夸大为全能力完成。

本系列不加入任意 CID 递归回源、Bitswap/DHT、DNSLink、Subdomain Gateway 或网站托管。递归回源不是 trustless 合规前提；若后续确有业务需求，应另建带访问策略、预算及循环保护的构想。任何生产部署、迁移或发布仍需独立授权。
