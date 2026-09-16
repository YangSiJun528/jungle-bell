package app.junglebell.architecture.fixtures.domain.account

import app.junglebell.architecture.fixtures.api.ApiUsingAccount
import app.junglebell.architecture.fixtures.common.CommonValue
import app.junglebell.architecture.fixtures.domain.publicapi.PublicData
import app.junglebell.architecture.fixtures.domain.security.Session

class AccountFeature(val session: Session, val common: CommonValue)
class AccountUsingApi(val api: ApiUsingAccount)
class AccountUsingPublicData(val data: PublicData)
class AccountUsingJdbcStore(val store: JdbcAccountStore)

interface AccountStore
class StorePortConsumer(val store: AccountStore)
class JdbcAccountStore : AccountStore {
    fun helper() = Helper(this)
    class Helper(val store: JdbcAccountStore)
}
