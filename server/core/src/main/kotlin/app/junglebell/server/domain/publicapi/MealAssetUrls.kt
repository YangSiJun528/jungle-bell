package app.junglebell.server.domain.publicapi

import java.net.URI

internal fun MealPost.withPublicAssetUrls(publicBaseUrl: URI): MealPost = copy(
    images = images.map { image ->
        image.copy(
            url = publicBaseUrl.resolve(
                "/api/public/assets/${image.sha}.${image.extension}",
            ).toString(),
        )
    },
)

internal fun WeeklyMealMenu.withPublicAssetUrls(publicBaseUrl: URI): WeeklyMealMenu = copy(
    post = post.withPublicAssetUrls(publicBaseUrl),
)

internal fun CurrentWeeklyMealMenu.withPublicAssetUrls(publicBaseUrl: URI): CurrentWeeklyMealMenu = copy(
    post = post?.withPublicAssetUrls(publicBaseUrl),
)
