package org.sozvon.app

import android.content.Context
import android.content.res.Configuration
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.WindowCompat

/**
 * Light or dark, for the app's own chrome.
 *
 * The web client offers three choices — follow the system, light, dark — and
 * reports the one in force over the SozvonApp bridge (see reportThemeToApp() in
 * static/galene.js).  What arrives is the *preference*, not the theme it
 * resolved to, which is what lets "system" keep meaning "system" here: the
 * app then follows the device on its own, including while no page is loaded.
 *
 * The choice is remembered, because the server list and the deploy wizard are
 * shown before any page has had a chance to report anything.  Without that,
 * an app whose client is set to light would open white-on-black every time
 * and correct itself a second later.
 */
object Theming {

    private const val PREFS = "sozvon"
    private const val KEY = "theme"

    /** The three values the client's own preference can take. */
    private const val SYSTEM = "system"
    private const val LIGHT = "light"
    private const val DARK = "dark"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun nightMode(pref: String?) = when (pref) {
        LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
        DARK -> AppCompatDelegate.MODE_NIGHT_YES
        else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
    }

    /**
     * Apply the remembered preference.  Call before setContentView: applying
     * it later means the activity is recreated to pick the mode up, which the
     * user sees as a flash of the wrong theme.
     */
    fun applyStored(context: Context) {
        AppCompatDelegate.setDefaultNightMode(
            nightMode(prefs(context).getString(KEY, SYSTEM)),
        )
    }

    /**
     * Remember a preference the client reported.  Deliberately *only*
     * remembers: switching the mode while the app is running recreates the
     * activity, and the activity is the one holding the WebView, so a person
     * changing the theme in the middle of a call would drop the call to do
     * it.
     *
     * Nothing is lost by waiting.  The only chrome of ours on screen while a
     * page is loaded is the two system bars, and those are set directly (see
     * applyBars); the server list and the deploy wizard are not visible then,
     * and pick the mode up the next time they are created.
     */
    fun store(context: Context, pref: String?) {
        val known = if (pref == LIGHT || pref == DARK) pref else SYSTEM
        prefs(context).edit().putString(KEY, known).apply()
    }

    /**
     * Dark icons on a light bar and vice versa.  The theme cannot state this
     * once and for all: android:windowLightStatusBar is a boolean that would
     * need its own values-night bucket, and its navigation-bar twin needs an
     * API bucket on top of that.  The compat controller settles both, and
     * no-ops where the platform cannot honour it.
     *
     * @param pref what the client last reported, or null to read the mode in
     *     force.  A freshly reported preference is not in the configuration
     *     yet — that is what makes the bars follow a live switch anyway.
     */
    @JvmOverloads
    fun applyBars(activity: AppCompatActivity, pref: String? = null) {
        val light = when (pref) {
            LIGHT -> true
            DARK -> false
            else -> activity.resources.configuration.uiMode and
                Configuration.UI_MODE_NIGHT_MASK != Configuration.UI_MODE_NIGHT_YES
        }
        val controller =
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.isAppearanceLightStatusBars = light
        controller.isAppearanceLightNavigationBars = light
    }
}
