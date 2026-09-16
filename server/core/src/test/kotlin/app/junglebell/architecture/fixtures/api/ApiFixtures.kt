package app.junglebell.architecture.fixtures.api

import app.junglebell.architecture.fixtures.domain.account.AccountFeature
import app.junglebell.architecture.fixtures.worker.WorkerUsingApi

class ApiUsingAccount(val account: AccountFeature)
class ApiUsingWorker(val worker: WorkerUsingApi)
